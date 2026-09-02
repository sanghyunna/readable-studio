import type { InputProps } from '../src';

type Assert<T extends true> = T;
type CheckboxIsExcluded = 'checkbox' extends NonNullable<InputProps['type']> ? false : true;
type TextIsSupported = 'text' extends NonNullable<InputProps['type']> ? true : false;

export type InputTypeContract = Assert<CheckboxIsExcluded> & Assert<TextIsSupported>;
