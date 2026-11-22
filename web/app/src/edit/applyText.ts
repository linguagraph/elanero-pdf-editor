// The commit an open paragraph editor asks its owner for (W6.8a 8a-1). Resolves true when the
// editor should close, false when the engine was busy and it stays open with its text. A type-only
// module, so the JSX of the layers does not carry the generic signature.
export type ApplyText = (text: string) => Promise<boolean>;
