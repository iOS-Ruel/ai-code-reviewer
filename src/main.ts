import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `
You are a senior iOS developer and code reviewer.

## Goal
Review the following Git diff of an iOS project and suggest only **meaningful** improvements.

The project mainly uses:
- Swift / SwiftUI / UIKit
- Combine and async/await
- Clean Architecture (UseCase, Repository, DataSource, Presentation), MVVM(-C) 패턴

## Review style
- 리뷰 코멘트는 **반드시 한국어로** 작성합니다.
- 사소한 스타일 지적(띄어쓰기, 단순 네이밍 취향 차이)은 웬만하면 하지 않습니다.
- 다음 항목을 우선적으로 봅니다:
  - 동시성 / 스레드 안전성 (async/await, Task, @MainActor, 공유 상태, race condition 가능성)
  - 아키텍처 분리 (View / ViewModel / UseCase / Repository / DataSource 책임이 섞여 있지 않은지)
  - 테스트 용이성, 의존성 주입 구조 (프로토콜, DI, 결합도)
  - 에러 처리, 옵셔널 처리, 크래시 가능성
  - 성능에 큰 영향을 줄 수 있는 부분 (불필요한 연산, 중복 호출 등)

## Output format (VERY IMPORTANT)
- 응답은 **반드시 아래 JSON 형식 그대로** 반환해야 합니다.

{"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}

- \`lineNumber\` 는 아래 Git diff에서 리뷰하고 싶은 **코드 라인 번호**입니다.
- \`reviewComment\` 에는 GitHub Markdown 형식으로 코멘트를 작성합니다.
- 개선할 부분이 전혀 없다면, \`"reviews": []\` 로 빈 배열을 반환합니다.
- 긍정적인 칭찬 코멘트는 작성하지 않습니다.
- 코드에 주석을 추가하라고 제안하지 않습니다.
- 응답은 **코드블럭(\`\`\`) 없이** 순수 JSON 문자열만 반환하세요. 맨 앞과 맨 뒤에 아무 텍스트도 추가하지 마세요.
- 아주 친절하고 부드러운 말투로 리뷰를 작성하세요.

## Context
아래 PR의 제목과 설명은 **맥락 파악용**으로만 사용하고, 실제 코멘트는 반드시 코드 변경 내용(diff)을 기준으로 작성하세요.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

## Git diff to review (file: "${file.to}"):

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    let raw = response.choices[0].message?.content?.trim() || "{}";

    // 1) ```로 둘러싸인 코드블록이면 제거
    if (raw.startsWith("```")) {
      // 맨 앞 ```json 또는 ``` 제거
      raw = raw.replace(/^```[a-zA-Z0-9]*\n/, "");
      // 맨 뒤 ``` 제거
      raw = raw.replace(/```$/, "").trim();
    }

    // 2) 혹시 이상한 텍스트가 섞여 있으면, 첫 { 부터 마지막 } 까지만 자르기
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      raw = raw.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(raw);

    // reviews가 없으면 빈 배열 반환
    return parsed.reviews || [];
  } catch (error) {
    console.error("Error while parsing AI response:", error);
    return null;
  }
}


function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
