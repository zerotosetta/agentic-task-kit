#!/usr/bin/env node
// A deterministic local CLI with the same -p/stdout contract as bxca.
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  prompt: { type: "string", short: "p" },
  model: { type: "string", short: "m" },
} });
const prompt = values.prompt ?? "";
const stage = /^ATK_BXCA_STAGE=(analysis|plan|review)$/m.exec(prompt)?.[1];
const json = /<documents>\n([\s\S]*)\n<\/documents>/.exec(prompt)?.[1];
if (!stage || !json) throw new Error("Expected a stage and documents in -p prompt.");
const documents = JSON.parse(json);
if (!documents.requirements || (stage !== "analysis" && !documents.analysis) ||
    (stage === "review" && !documents.plan)) {
  throw new Error("Previous workflow documents were not passed to the command.");
}
// This fixture demonstrates orchestration; its canned output is not an AI assessment.
const headings = {
  analysis: "# 요구사항 분석 (로컬 데모)",
  plan: "# 실행 계획 (로컬 데모)",
  review: "# 검토 보고서 (로컬 데모)",
};
const body = {
  analysis: "- 목표: 모바일 이체 한도 조회 및 변경\n- 제약: 추가 인증, 한도 검증, 변경 이력, 중복 요청 방지\n- 확인 질문: 고객별 최대 한도와 인증 수단은 무엇인가?",
  plan: "1. 미확정 정책과 기존 API 확인\n2. 한도 검증 및 중복 요청 처리 설계\n3. 인증과 변경 이력 연동\n4. 인증 실패, 네트워크 오류, 동시 변경 테스트 정의",
  review: "- 우선 확인: 고객 등급별 최대 한도와 추가 인증 수단\n- 위험: 중복 요청 및 동시 변경 시 일관성\n- 다음 행동: 담당자 정책 확인 후 API 수용 기준 확정\n- 이 결과는 실행 흐름을 보여주는 고정 데모이며 실제 분석/구현/테스트 완료를 뜻하지 않는다.",
};
process.stdout.write(`${headings[stage]}\n\n${body[stage]}\n`);
