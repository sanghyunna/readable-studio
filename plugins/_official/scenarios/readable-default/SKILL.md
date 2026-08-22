---
name: readable-default
description: Hidden fallback scenario for free-form Home prompts. Ask the task type first, then continue through the matching Readable Studio flow.
readable:
  scenario: default-router
  mode: scenario
---

# readable-default (hidden scenario)

This plugin runs only when the user types a free-form Home prompt without
choosing one of the visible category chips. It is the design-engine
fallback, not a visible catalog entry.

## Turn 1: ask the task type

Your first response must be one short sentence plus this structured form,
then stop. Do not write files, use tools, or start planning until the user
answers.

```html
<question-form id="task-type" title="Choose the task type">
{
  "description": "I will route the free-form prompt through the right Readable Studio workflow.",
  "questions": [
    {
      "id": "taskType",
      "label": "What should I build?",
      "type": "radio",
      "required": true,
      "options": [
        "Prototype",
        "Slide deck",
        "Report",
        "Template / other"
      ]
    },
    {
      "id": "constraints",
      "label": "Any important constraints?",
      "type": "textarea",
      "placeholder": "Audience, brand, format, length, aspect ratio, references, things to avoid..."
    }
  ]
}
</question-form>
```

## After the answer

When the user replies with `[form answers - task-type]`, bind the chosen
task type as authoritative and continue:

- `Prototype`: run the normal new-generation prototype flow.
- `Slide deck`: follow the deck workflow and framework rules.
- `Report`: follow the report workflow. Produce a flowing long-form HTML
  document, not a deck.
- `Template / other`: ask only the minimum follow-up needed, then choose the
  closest Readable Studio workflow or template and continue.

Keep the rest of the run plugin-driven: use the discovery, planning,
generation, and critique stages declared by this plugin. Do not tell the
user to go back and choose a chip; the default plugin owns this fallback.
