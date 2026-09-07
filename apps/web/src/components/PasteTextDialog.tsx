import { useState } from 'react';
import { motion } from 'motion/react';
import { Button, Input, Textarea } from '@readable-studio/components';
import { useT } from '../i18n';
import { modalOverlay, modalContent, useFadingSurface } from '../motion';

interface Props {
  onSave: (name: string, content: string) => void;
  onClose: () => void;
}

export function PasteTextDialog({ onSave, onClose }: Props) {
  const t = useT();
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  // The dismissal fade is a transition: only the exit gate can keep this
  // dialog's controls out of pointer and Tab reach while it is transparent.
  const backdropMotion = useFadingSurface(modalOverlay);
  const contentMotion = useFadingSurface(modalContent);

  function commit() {
    const trimmed = content.trim();
    if (!trimmed) return;
    const finalName = name.trim() || `paste-${Date.now()}.txt`;
    onSave(ensureExtension(finalName, '.txt'), content);
  }

  return (
    <motion.div className="modal-backdrop" onClick={onClose} {...backdropMotion}>
      <motion.div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        {...contentMotion}
      >
        <h2>{t('pasteDialog.title')}</h2>
        <p className="hint">{t('pasteDialog.hint')}</p>
        <label>
          {t('pasteDialog.fileNameLabel')}
          <Input
            type="text"
            value={name}
            placeholder={t('pasteDialog.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          {t('pasteDialog.contentLabel')}
          <Textarea
            rows={10}
            value={content}
            placeholder={t('pasteDialog.contentPlaceholder')}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        <div className="row">
          <Button onClick={onClose}>{t('pasteDialog.cancel')}</Button>
          <Button variant="primary" onClick={commit} disabled={!content.trim()}>
            {t('pasteDialog.save')}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ensureExtension(name: string, ext: string): string {
  if (/\.[a-z0-9]+$/i.test(name)) return name;
  return `${name}${ext}`;
}
