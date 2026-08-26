import {
  BRAND_SEED_BY_PLUGIN_ID,
  deriveBrandHue,
  resolveScheme,
} from './mentionBrandHue';

const managerByDocument = new WeakMap<Document, Manager>();

function brandSeed(kind: string, mentionId: string): string | undefined {
  if (kind !== 'plugin') return undefined;
  if (!Object.prototype.hasOwnProperty.call(BRAND_SEED_BY_PLUGIN_ID, mentionId)) return undefined;
  return BRAND_SEED_BY_PLUGIN_ID[mentionId];
}

class Manager {
  private readonly root: HTMLElement;
  private readonly seedByElement = new WeakMap<HTMLElement, string>();
  private readonly elements = new Set<WeakRef<HTMLElement>>();
  private readonly observer: MutationObserver;

  constructor(private readonly ownerDocument: Document) {
    this.root = ownerDocument.documentElement;
    this.observer = new MutationObserver(() => {
      this.restamp();
    });
    this.observer.observe(this.root, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-scheme'],
    });
  }

  stamp(element: HTMLElement, kind: string, mentionId: string): void {
    const seed = brandSeed(kind, mentionId);
    if (seed === undefined) {
      element.style.removeProperty('--m-hue');
      this.untrack(element);
      return;
    }

    const isTracked = this.seedByElement.has(element);
    this.seedByElement.set(element, seed);
    if (!isTracked) this.elements.add(new WeakRef(element));
    this.setHue(element, seed, resolveScheme(this.root), this.panelHex());
  }

  private untrack(element: HTMLElement): void {
    this.seedByElement.delete(element);
    for (const reference of this.elements) {
      const trackedElement = reference.deref();
      if (trackedElement === undefined || trackedElement === element) {
        this.elements.delete(reference);
      }
    }
  }

  private restamp(): void {
    const scheme = resolveScheme(this.root);
    const panelHex = this.panelHex();
    for (const reference of this.elements) {
      const element = reference.deref();
      const seed = element ? this.seedByElement.get(element) : undefined;
      if (!element || !element.isConnected || seed === undefined) {
        this.elements.delete(reference);
        if (element) this.seedByElement.delete(element);
        continue;
      }
      this.setHue(element, seed, scheme, panelHex);
    }
  }

  private panelHex(): string {
    const panelHex =
      this.ownerDocument.defaultView
        ?.getComputedStyle(this.root)
        .getPropertyValue('--bg-panel')
        .trim() ?? '';
    return /^#[0-9a-f]{6}$/i.test(panelHex) ? panelHex : '#222120';
  }

  private setHue(
    element: HTMLElement,
    seed: string,
    scheme: 'light' | 'dark',
    panelHex: string,
  ): void {
    element.style.setProperty('--m-hue', deriveBrandHue(seed, scheme, panelHex));
  }
}

export function applyMentionBrandHue(
  element: HTMLElement,
  kind: string,
  mentionId: string,
): void {
  const ownerDocument = element.ownerDocument;
  let manager = managerByDocument.get(ownerDocument);
  if (!manager) {
    manager = new Manager(ownerDocument);
    managerByDocument.set(ownerDocument, manager);
  }
  manager.stamp(element, kind, mentionId);
}
