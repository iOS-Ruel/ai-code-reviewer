import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import * as https from "https"; // ✅ Node 16 환경용 HTTPS 모듈

// ====== GitHub Action Inputs ======
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const SLACK_WEBHOOK_URL: string = core.getInput("SLACK_WEBHOOK_URL"); // ✅ Slack Webhook 입력

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ====== Types ======
interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  url: string; // ✅ Slack에서 링크로 사용
}

type ReviewComment = { body: string; path: string; line: number };

// ====== GitHub PR 관련 함수 ======
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
    url: prResponse.data.html_url ?? "",
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

// ====== 메인 분석 로직 ======
async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<ReviewComment>> {
  const comments: Array<ReviewComment> = [];

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

// ====== 프롬프트 생성 ======
function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `
당신은 시니어 iOS 개발자이자 코드 리뷰어입니다.

## 말투 / 스타일 (아주 중요)
- 리뷰 코멘트는 **반드시 한국어로** 작성합니다.
- 항상 **부드럽고 친절하고, 약간 애교 섞인 말투**로 작성합니다.
- 문장 끝에는 자주 \`~했어용\`, \`~이에용\`, \`~같아용\` 같은 표현을 사용해 주세요.
- 적절히 😊 🐶 💡 같은 이모티콘을 섞어서 써 주세요.
- 너무 딱딱한 문장(\`합니다\`, \`입니다\`체)보다는 말랑한 어투를 사용해 주세요.

## 리뷰 관점
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
- 코드에 주석을 추가하라고 제안하지 않습니다.
- 응답은 **코드블럭(\`\`\`) 없이** 순수 JSON 문자열만 반환하세요. 맨 앞과 맨 뒤에 아무 텍스트도 추가하지 마세요.

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

// ====== OpenAI 호출 + JSON 파싱 ======
async function getAIResponse(prompt: string): Promise<
  Array<{
    lineNumber: string;
    reviewComment: string;
  }> | null
> {
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
      // ✅ 항상 JSON 객체로 받도록 강제
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const raw = response.choices[0].message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw);

    return parsed.reviews || [];
  } catch (error) {
    console.error("Error while parsing AI response:", error);
    return null;
  }
}

// ====== GitHub Review Comment 생성 ======
function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<ReviewComment> {
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
  comments: Array<ReviewComment>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

// ====== Slack 전송 유틸 ======
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function postToSlack(webhookUrl: string, payload: any): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const data = JSON.stringify(payload);
      const url = new URL(webhookUrl);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      });

      req.on("error", (error) => {
        console.error("Error sending Slack message:", error);
        reject(error);
      });

      req.write(data);
      req.end();
    } catch (error) {
      console.error("Error building Slack request:", error);
      reject(error);
    }
  });
}

async function notifySlack(
  prDetails: PRDetails,
  comments: ReviewComment[]
): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("SLACK_WEBHOOK_URL is not set. Skipping Slack notification.");
    return;
  }

  const baseText =
    comments.length === 0
      ? "이번 PR에서는 특별히 지적할 부분은 없었어용 😊"
      : `이번 PR에 대해 *${comments.length}개*의 리뷰 코멘트가 생성되었어용. 주요 내용 일부만 정리해 드릴게요 🐶`;

  const maxItems = 5;
  const summarized = comments.slice(0, maxItems).map((c) => {
    const oneLineBody = c.body.replace(/\n/g, " ");
    return `• \`${c.path}:${c.line}\` — ${truncate(oneLineBody, 200)}`;
  });

  const slackText = [baseText, "", ...summarized].join("\n");

  const payload = {
    text: "AI 코드 리뷰 결과", // fallback
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*AI 코드 리뷰 결과에요 🧁*\n*PR:* <${prDetails.url}|${prDetails.title}>`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: slackText,
        },
      },
    ],
  };

  await postToSlack(SLACK_WEBHOOK_URL, payload);
}

// ====== main ======
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

  // ✅ 리뷰 결과를 슬랙으로 요약 전송
  await notifySlack(prDetails, comments);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
