import assert from "node:assert/strict";
import test from "node:test";

import { classifyComplexity, type ClassifierMetadata } from "../classifier";

const ref = (uri: string) => ({ id: uri, value: uri } as any);

test("classifies a short simple prompt as simple", () => {
  const result = classifyComplexity("How do I create a file?", []);
  assert.equal(result.tier, "simple");
  assert.ok(result.score <= 2);
});

test("classifies a long prompt with keywords as medium or complex", () => {
  const prompt = "I need you to refactor the authentication system. " +
    "The current implementation has security vulnerabilities and we need " +
    "to redesign the architecture to support microservices. First, audit " +
    "the existing code, then create a migration plan, and finally implement " +
    "the new design pattern.";
  const result = classifyComplexity(prompt, []);
  assert.ok(result.tier === "medium" || result.tier === "complex");
  assert.ok(result.score > 3);
});

test("scores code blocks", () => {
  const prompt = "What does this do?\n```typescript\nconst a = 1;\nconst b = 2;\n```";
  const result = classifyComplexity(prompt, []);
  assert.ok(result.score >= 1);
  assert.ok(result.reasons.some((reason) => reason.includes("code block")));
});

test("scores many file references higher", () => {
  const refs = Array.from({ length: 8 }, (_, index) => ref(`file${index}.ts`));
  const result = classifyComplexity("refactor these files", refs);
  assert.ok(result.reasons.some((reason) => reason.includes("file references")));
});

test("supports inferred file references from metadata", () => {
  const metadata: ClassifierMetadata = { referencedFileCount: 5 };
  const result = classifyComplexity("please update #file:src/a.ts and src/b.ts", [], metadata);
  assert.ok(result.reasons.some((reason) => reason.includes("file references")));
});

test("strips code blocks before keyword scanning", () => {
  const withCodeAsync = "What is this?\n```js\nasync function foo() {}\n```";
  const result = classifyComplexity(withCodeAsync, []);
  const keywordReason = result.reasons.find((reason) => reason.includes("complexity keywords"));
  assert.equal(keywordReason, undefined);
});

test("detects multi-step patterns", () => {
  const prompt = "First, create the database. Then, add the schema. Finally, seed the data.";
  const result = classifyComplexity(prompt, []);
  assert.ok(result.reasons.some((reason) => reason.includes("multi-step")));
});

test("detects intent: explain is low-cost", () => {
  const result = classifyComplexity("Explain what this function does", []);
  assert.ok(result.reasons.some((reason) => reason.includes("explain")));
});

test("detects intent: review/audit is high-cost", () => {
  const result = classifyComplexity("Review this code for security issues and find bugs", []);
  assert.ok(result.reasons.some((reason) => reason.includes("review")));
});

test("reduces score for clear stack trace and fix request", () => {
  const prompt = "Fix this error:\n```\nTypeError: Cannot read properties of undefined\n  at Function.main (index.js:42)\n```";
  const result = classifyComplexity(prompt, []);
  assert.ok(result.reasons.some((reason) => reason.includes("stack trace")));
});

test("detects ambiguous short prompts", () => {
  const result = classifyComplexity("fix this", []);
  assert.ok(result.reasons.some((reason) => reason.includes("ambiguous") || reason.includes("vague")));
});

test("scores conversation depth from metadata", () => {
  const metadata: ClassifierMetadata = { messageCount: 8 };
  const result = classifyComplexity("continue", [], metadata);
  assert.ok(result.reasons.some((reason) => reason.includes("conversation")));
});

test("scores agent mode from metadata", () => {
  const metadata: ClassifierMetadata = { hasTools: true };
  const result = classifyComplexity("search for all usages", [], metadata);
  assert.ok(result.reasons.some((reason) => reason.includes("agent mode")));
});

test("keeps short tool-enabled prompts out of complex tier", () => {
  const metadata: ClassifierMetadata = { hasTools: true, messageCount: 2 };
  const result = classifyComplexity("list files in src", [], metadata);
  assert.notEqual(result.tier, "complex");
  assert.ok(result.score <= 6);
});

test("requires a higher score before using complex tier", () => {
  const metadata: ClassifierMetadata = {
    hasTools: true,
    messageCount: 10,
    activeLanguageId: "rust",
    referencedFileCount: 6,
  };
  const prompt = "Review the architecture, refactor the parser, optimize performance, and fix the race condition across these modules.";
  const result = classifyComplexity(prompt, [], metadata);
  assert.ok(result.score >= 9);
  assert.equal(result.tier, "complex");
});

test("scores complex active language contexts", () => {
  const metadata: ClassifierMetadata = { activeLanguageId: "rust" };
  const result = classifyComplexity("help me with ownership rules", [], metadata);
  assert.ok(result.reasons.some((reason) => reason.includes("complex language context")));
});
