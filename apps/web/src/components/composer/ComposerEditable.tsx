import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

type Props = {
  readonly testId: string;
  readonly placeholder: string;
  readonly title: string | undefined;
  readonly expanded: boolean;
  readonly activeId: string | null;
  readonly listboxId: string;
  readonly invalid: boolean;
};

// Lexical owns the text DOM and empty/non-empty placeholder subscriptions.
export function ComposerEditable({
  testId, placeholder, title, expanded, activeId, listboxId, invalid,
}: Props) {
  return (
    <div className="composer-input-editor">
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            data-testid={testId}
            className="ph-no-capture composer-editable"
            aria-placeholder={placeholder}
            title={title}
            role="combobox"
            aria-expanded={expanded ? 'true' : 'false'}
            aria-invalid={invalid ? 'true' : undefined}
            aria-controls={listboxId}
            {...(activeId ? { 'aria-activedescendant': activeId } : {})}
            placeholder={<div className="composer-input-placeholder">{placeholder}</div>}
          />
        }
        placeholder={<div className="composer-input-placeholder">{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
    </div>
  );
}
