import { expect, type Page } from '@playwright/test';
import { T } from '../timeouts.js';

/** Enter through Lexical's native keyboard path, not contenteditable DOM fill. */
export async function enterHomeFirstTurnPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId('home-hero-input');
  await expect(input).toBeEditable({ timeout: T.medium });
  await expect(input).toHaveText('');
  await input.click();
  await expect(input).toBeFocused();
  // fill() can complete while the newly mounted controlled editor is still
  // empty. Focus first, then drive key/input events without artificial delays.
  await input.pressSequentially(prompt);
  await expect(input).toHaveText(prompt);
  // This observes HomeView's committed draft, not just painted DOM text. Fail
  // here if editing never reached the submit guard, rather than timing out on
  // unrelated project/run response waiters for a click that never happened.
  await expect(page.getByTestId('home-hero-submit')).toBeEnabled({ timeout: T.medium });
}
