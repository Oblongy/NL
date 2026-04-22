import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(currentDir, "..");
const dataDir = resolve(backendRoot, "data");
const defaultDefinitionsPath = resolve(dataDir, "home-polls.json");
const defaultVotesPath = resolve(dataDir, "home-poll-votes.json");

function ensureDataDir() {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

function readJsonFile(filePath, fallbackValue) {
  try {
    if (!existsSync(filePath)) {
      return fallbackValue;
    }

    const raw = readFileSync(filePath, "utf8").trim();
    return raw ? JSON.parse(raw) : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toPositiveId(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? String(Math.trunc(numericValue)) : null;
}

function normalizeAnswer(answer) {
  const answerId = toPositiveId(answer?.answerId ?? answer?.oid ?? answer?.id);
  const answerText = String(answer?.answer ?? answer?.o ?? answer?.text ?? "").trim();
  if (!answerId || !answerText) {
    return null;
  }

  return {
    answerId,
    answer: answerText,
  };
}

function normalizeQuestion(question) {
  const questionId = toPositiveId(question?.questionId ?? question?.qid ?? question?.id);
  const questionText = String(question?.question ?? question?.q ?? question?.text ?? "").trim();
  const answers = Array.isArray(question?.answers)
    ? question.answers.map(normalizeAnswer).filter(Boolean)
    : [];

  if (!questionId || !questionText || answers.length === 0) {
    return null;
  }

  return {
    questionId,
    question: questionText,
    answers,
  };
}

function normalizePollDefinition(poll) {
  const surveyId = toPositiveId(poll?.surveyId ?? poll?.sid ?? poll?.id);
  const questions = Array.isArray(poll?.questions)
    ? poll.questions.map(normalizeQuestion).filter(Boolean)
    : [];

  if (!surveyId || questions.length === 0) {
    return null;
  }

  return {
    surveyId,
    name: String(poll?.name ?? poll?.title ?? `Survey ${surveyId}`),
    active: poll?.active !== false,
    startAt: poll?.startAt ? String(poll.startAt) : null,
    endAt: poll?.endAt ? String(poll.endAt) : null,
    questions,
  };
}

function normalizeDefinitions(rawDefinitions) {
  const polls = Array.isArray(rawDefinitions?.polls)
    ? rawDefinitions.polls.map(normalizePollDefinition).filter(Boolean)
    : [];

  return { polls };
}

function normalizeVotes(rawVotes) {
  const answersByPlayerId = {};

  for (const [playerId, answeredQuestions] of Object.entries(rawVotes?.answersByPlayerId || {})) {
    const normalizedPlayerId = toPositiveId(playerId);
    if (!normalizedPlayerId || !answeredQuestions || typeof answeredQuestions !== "object") {
      continue;
    }

    const normalizedAnswers = {};
    for (const [questionId, answerRecord] of Object.entries(answeredQuestions)) {
      const normalizedQuestionId = toPositiveId(questionId);
      const surveyId = toPositiveId(answerRecord?.surveyId);
      const answerId = toPositiveId(answerRecord?.answerId);
      const votedAt = String(answerRecord?.votedAt || "");
      if (!normalizedQuestionId || !surveyId || !answerId) {
        continue;
      }

      normalizedAnswers[normalizedQuestionId] = {
        surveyId,
        answerId,
        votedAt,
      };
    }

    answersByPlayerId[normalizedPlayerId] = normalizedAnswers;
  }

  return { answersByPlayerId };
}

function isPollActive(poll, nowMs) {
  if (!poll.active) {
    return false;
  }

  if (poll.startAt) {
    const startMs = Date.parse(poll.startAt);
    if (Number.isFinite(startMs) && nowMs < startMs) {
      return false;
    }
  }

  if (poll.endAt) {
    const endMs = Date.parse(poll.endAt);
    if (Number.isFinite(endMs) && nowMs > endMs) {
      return false;
    }
  }

  return true;
}

export class HomePollState {
  constructor({ logger = null, definitionsPath = defaultDefinitionsPath, votesPath = defaultVotesPath } = {}) {
    this.logger = logger;
    this.definitionsPath = definitionsPath;
    this.votesPath = votesPath;

    ensureDataDir();
    this.definitions = normalizeDefinitions(readJsonFile(this.definitionsPath, { polls: [] }));
    this.votes = normalizeVotes(readJsonFile(this.votesPath, { answersByPlayerId: {} }));

    if (!existsSync(this.votesPath)) {
      this.persistVotes();
    }

    this.logger?.info("Home poll state initialized", {
      definitionsPath: this.definitionsPath,
      votesPath: this.votesPath,
      pollCount: this.definitions.polls.length,
    });
  }

  persistVotes() {
    writeJsonFile(this.votesPath, this.votes);
  }

  getAnsweredQuestionsForPlayer(playerId) {
    const normalizedPlayerId = toPositiveId(playerId);
    if (!normalizedPlayerId) {
      return {};
    }

    return this.votes.answersByPlayerId[normalizedPlayerId] || {};
  }

  getVisiblePollsForPlayer(playerId, nowMs = Date.now()) {
    const answeredQuestions = this.getAnsweredQuestionsForPlayer(playerId);

    return this.definitions.polls
      .filter((poll) => isPollActive(poll, nowMs))
      .map((poll) => ({
        ...poll,
        questions: poll.questions.filter((question) => !answeredQuestions[question.questionId]),
      }))
      .filter((poll) => poll.questions.length > 0);
  }

  renderPollNodeForPlayer(playerId, nowMs = Date.now()) {
    const visiblePolls = this.getVisiblePollsForPlayer(playerId, nowMs);
    if (visiblePolls.length === 0) {
      return "<n id='poll'><s/></n>";
    }

    const surveysXml = visiblePolls
      .map((poll) => {
        const questionsXml = poll.questions
          .map((question) => {
            const answersXml = question.answers
              .map((answer) => `<o oid='${escapeXml(answer.answerId)}' o='${escapeXml(answer.answer)}'/>`)
              .join("");
            return `<q qid='${escapeXml(question.questionId)}' q='${escapeXml(question.question)}'>${answersXml}</q>`;
          })
          .join("");
        return `<v sid='${escapeXml(poll.surveyId)}'>${questionsXml}</v>`;
      })
      .join("");

    return `<n id='poll'><s>${surveysXml}</s></n>`;
  }

  submitAnswer({ playerId, surveyId, questionId, answerId }) {
    const normalizedPlayerId = toPositiveId(playerId);
    let normalizedSurveyId = toPositiveId(surveyId);
    const normalizedQuestionId = toPositiveId(questionId);
    const normalizedAnswerId = toPositiveId(answerId);

    if (!normalizedPlayerId || !normalizedQuestionId || !normalizedAnswerId) {
      return { ok: false, code: -1, reason: "invalid-ids" };
    }

    let poll = this.definitions.polls.find((entry) => entry.surveyId === normalizedSurveyId);
    if (!poll && !normalizedSurveyId) {
      poll = this.definitions.polls.find((entry) =>
        entry.questions.some((question) => question.questionId === normalizedQuestionId),
      );
      normalizedSurveyId = poll?.surveyId || null;
    }

    if (!poll || !isPollActive(poll, Date.now())) {
      return { ok: false, code: -2, reason: "survey-inactive" };
    }

    const question = poll.questions.find((entry) => entry.questionId === normalizedQuestionId);
    if (!question) {
      return { ok: false, code: -3, reason: "question-missing" };
    }

    const answer = question.answers.find((entry) => entry.answerId === normalizedAnswerId);
    if (!answer) {
      return { ok: false, code: -4, reason: "answer-missing" };
    }

    const answeredQuestions = this.getAnsweredQuestionsForPlayer(normalizedPlayerId);
    if (answeredQuestions[normalizedQuestionId]) {
      return {
        ok: true,
        code: 1,
        reason: "already-answered",
        record: answeredQuestions[normalizedQuestionId],
      };
    }

    this.votes.answersByPlayerId[normalizedPlayerId] = {
      ...answeredQuestions,
      [normalizedQuestionId]: {
        surveyId: normalizedSurveyId,
        answerId: normalizedAnswerId,
        votedAt: new Date().toISOString(),
      },
    };
    this.persistVotes();

    return {
      ok: true,
      code: 1,
      reason: "saved",
      record: this.votes.answersByPlayerId[normalizedPlayerId][normalizedQuestionId],
    };
  }
}

export function createHomePollState(options) {
  return new HomePollState(options);
}
