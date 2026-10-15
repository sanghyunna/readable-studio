import { describe, expect, it } from 'vitest';
import { buildTemplateCreateInput } from '../../src/components/project-create';
import type { ProjectTemplate } from '../../src/types';

describe('template creation design-system defaults', () => {
  it.each(['default', 'neutral-modern', 'user:brand'])(
    'does not infer a design system from template %s',
    (id) => {
      const template = { id, name: 'Template', designSystemId: id } as unknown as ProjectTemplate;
      const input = buildTemplateCreateInput(template, 'New project');
      expect(input.designSystemId).toBeNull();
      expect(input.name).toBe('New project');
      expect(input.metadata.templateId).toBe(id);
    },
  );
});
