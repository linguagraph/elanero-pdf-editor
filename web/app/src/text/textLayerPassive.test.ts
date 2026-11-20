import { describe, expect, it } from 'vitest';
import { textLayerPassive } from './textLayerPassive';

describe('textLayerPassive', () => {
  const idle = { commentTool: null, viewTool: 'select', markToolOn: false } as const;

  it('leaves text selection alone when no gesture tool is armed', () => {
    expect(textLayerPassive(idle)).toBe(false);
    expect(textLayerPassive({ ...idle, viewTool: 'hand' })).toBe(false);
    expect(textLayerPassive({ ...idle, viewTool: 'edit' })).toBe(false);
  });

  it('is passive with a comment tool armed', () => {
    expect(textLayerPassive({ ...idle, commentTool: 'highlight' as never })).toBe(true);
  });

  it('is passive with the redaction mark tool armed (the layer is below the text layer)', () => {
    expect(textLayerPassive({ ...idle, markToolOn: true })).toBe(true);
  });

  it('is passive with the crop box tool armed (the layer is below the text layer)', () => {
    expect(textLayerPassive({ ...idle, viewTool: 'cropBox' })).toBe(true);
  });
});
