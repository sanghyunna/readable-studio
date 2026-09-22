/** Reveal a question inside its scroll owner, never its overflow-hidden ancestors. */
export function scrollQuestionIntoView(log: HTMLElement, question: HTMLElement): void {
  log.scrollTo({
    top: log.scrollTop + question.getBoundingClientRect().top - log.getBoundingClientRect().top - log.clientTop,
    behavior: 'smooth',
  });
}
