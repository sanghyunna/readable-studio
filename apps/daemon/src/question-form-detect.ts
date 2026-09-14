// Keep every daemon consumer on the same wire parser as the web UI, including
// Markdown code exclusions and recovery of complete JSON without a close tag.
export {
  QUESTION_FORM_OPEN_RE,
  questionFormBodyIsRenderable,
  findQuestionFormCloseTag,
  emittedRenderableQuestionForm,
} from '@readable-studio/contracts';
