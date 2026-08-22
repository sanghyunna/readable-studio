// @dsp func-0e52a91c
export function joinClassNames(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(' ') || undefined;
}
