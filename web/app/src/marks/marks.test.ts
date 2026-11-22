import { describe, expect, it } from 'vitest';
import type { ActionJobEngine } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { EN } from '../i18n/en';
import type { MarkDetailResult } from '../rpc/generated';
import {
  BACKGROUND_ACTION,
  backgroundArgs,
  canRunBackground,
  canRunHeaderFooter,
  canRunWatermark,
  colorToHex,
  fromMarkDetail,
  getMark,
  type HeaderFooterForm,
  HEADER_FOOTER_ACTION,
  headerFooterArgs,
  hexToColor,
  listMarks,
  MARK_LIMITS,
  markPages,
  REMOVE_ACTION,
  removeArgs,
  runMark,
  WATERMARK_ACTION,
  type WatermarkForm,
  watermarkArgs,
} from './marks';

const BATES = { prefix: 'ABC', start: 1, digits: 6, suffix: '' };

const HEADER_FOOTER: HeaderFooterForm = {
  texts: { header_left: 'Draft', footer_right: 'Page <<page>> of <<pages>>' },
  font: 'helv',
  fontSize: 9,
  color: '#000000',
  marginX: 36,
  marginY: 24,
  bates: BATES,
};

const WATERMARK: WatermarkForm = {
  text: 'CONFIDENTIAL',
  font: 'hebo',
  fontSize: 60,
  color: '#bf1a1a',
  opacity: 0.3,
  angle: 45,
  onTop: true,
};

describe('hexToColor and colorToHex', () => {
  it('turns #rrggbb into channels from 0 to 1', () => {
    expect(hexToColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0 });
    expect(hexToColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToColor('#FFFFFF')).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToColor('#808080')?.g).toBeCloseTo(128 / 255, 10);
  });

  it('refuses anything that is not six hex digits with a hash', () => {
    expect(hexToColor('#fff')).toBeUndefined();
    expect(hexToColor('red')).toBeUndefined();
    expect(hexToColor('#gg0000')).toBeUndefined();
    expect(hexToColor('ff0000')).toBeUndefined();
  });

  it('writes a colour back as #rrggbb, clamped to the channel range', () => {
    expect(colorToHex({ r: 1, g: 0, b: 0 })).toBe('#ff0000');
    expect(colorToHex({ r: 0xbf / 255, g: 0x1a / 255, b: 0x1a / 255 })).toBe('#bf1a1a');
    expect(colorToHex({ r: 1.5, g: -1, b: 0 })).toBe('#ff0000');
  });
});

describe('headerFooterArgs', () => {
  it('drops empty and blank slots and keeps the rest', () => {
    const form = {
      ...HEADER_FOOTER,
      texts: { header_left: 'Draft', footer_left: '   ', footer_center: '' },
    };
    const args = headerFooterArgs(form, [0, 2], 'contract.pdf', false, false);
    expect(args.spec.texts).toEqual({ header_left: 'Draft' });
    expect(args.pages).toEqual([0, 2]);
    expect(args.file_name).toBe('contract.pdf');
  });

  it('builds the spec with snake_case keys, an RGB colour and one margin for top and bottom', () => {
    const args = headerFooterArgs(HEADER_FOOTER, [0], 'a.pdf', false, false);
    expect(args.spec).toEqual({
      texts: { header_left: 'Draft', footer_right: 'Page <<page>> of <<pages>>' },
      font: 'helv',
      font_size: 9,
      color: { r: 0, g: 0, b: 0 },
      margin_x: 36,
      margin_top: 24,
      margin_bottom: 24,
      bates_prefix: 'ABC',
      bates_start: 1,
      bates_digits: 6,
      bates_suffix: '',
    });
  });

  it('always sends the Bates fields, in header mode too', () => {
    const plain = headerFooterArgs(HEADER_FOOTER, [0], 'a.pdf', false, false);
    expect(plain.bates).toBe(false);
    expect(plain.spec).toMatchObject({
      bates_prefix: 'ABC',
      bates_start: 1,
      bates_digits: 6,
      bates_suffix: '',
    });

    const bates = headerFooterArgs(HEADER_FOOTER, [0], 'a.pdf', true, false);
    expect(bates.bates).toBe(true);
    expect(bates.spec.bates_prefix).toBe('ABC');
  });

  it('passes replace_existing through', () => {
    expect(headerFooterArgs(HEADER_FOOTER, [0], 'a.pdf', false, true).replace_existing).toBe(true);
    expect(headerFooterArgs(HEADER_FOOTER, [0], 'a.pdf', false, false).replace_existing).toBe(
      false,
    );
  });
});

describe('watermarkArgs', () => {
  it('builds the watermark spec', () => {
    expect(watermarkArgs(WATERMARK, [1, 3], true)).toEqual({
      spec: {
        text: 'CONFIDENTIAL',
        font: 'hebo',
        font_size: 60,
        color: { r: 0xbf / 255, g: 0x1a / 255, b: 0x1a / 255 },
        opacity: 0.3,
        angle: 45,
        on_top: true,
      },
      pages: [1, 3],
      replace_existing: true,
    });
  });
});

describe('backgroundArgs and removeArgs', () => {
  it('builds the background and remove arguments', () => {
    expect(backgroundArgs('#ff0000', 1, [0], false)).toEqual({
      color: { r: 1, g: 0, b: 0 },
      opacity: 1,
      pages: [0],
      replace_existing: false,
    });
    expect(removeArgs('Watermark')).toEqual({ kind: 'Watermark' });
  });
});

describe('markPages', () => {
  it('names every page for the all scope', () => {
    expect(markPages('all', '', 3, 1)).toEqual([0, 1, 2]);
  });

  it('names the current page, one-based in the view', () => {
    expect(markPages('current', '', 3, 2)).toEqual([1]);
    expect(markPages('current', '', 3, 4)).toBeUndefined();
  });

  it('parses a typed range into sorted zero-based pages', () => {
    expect(markPages('range', '4, 1-2', 5, 1)).toEqual([0, 1, 3]);
    expect(markPages('range', '1-9', 5, 1)).toBeUndefined();
    expect(markPages('range', '', 5, 1)).toBeUndefined();
  });
});

describe('canRunHeaderFooter', () => {
  it('runs with at least one text slot, pages and valid values', () => {
    expect(canRunHeaderFooter(HEADER_FOOTER, [0])).toBe(true);
  });

  it('refuses no pages, no text, or blank text only', () => {
    expect(canRunHeaderFooter(HEADER_FOOTER, [])).toBe(false);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, texts: {} }, [0])).toBe(false);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, texts: { header_left: '  ' } }, [0])).toBe(false);
  });

  it('refuses a font size outside 4 to 72', () => {
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, fontSize: 3 }, [0])).toBe(false);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, fontSize: 72 }, [0])).toBe(true);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, fontSize: 73 }, [0])).toBe(false);
  });

  it('refuses Bates digits outside 1 to 15 and a start outside 0 to 10^9', () => {
    const bates = (fields: Partial<typeof BATES>): HeaderFooterForm => ({
      ...HEADER_FOOTER,
      bates: { ...BATES, ...fields },
    });
    expect(canRunHeaderFooter(bates({ digits: 0 }), [0])).toBe(false);
    expect(canRunHeaderFooter(bates({ digits: 16 }), [0])).toBe(false);
    expect(canRunHeaderFooter(bates({ digits: 15 }), [0])).toBe(true);
    expect(canRunHeaderFooter(bates({ start: -1 }), [0])).toBe(false);
    expect(canRunHeaderFooter(bates({ start: 1_000_000_000 }), [0])).toBe(true);
    expect(canRunHeaderFooter(bates({ start: 1_000_000_001 }), [0])).toBe(false);
  });

  it('refuses a bad colour and a margin outside 0 to 500 on either side', () => {
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, color: 'black' }, [0])).toBe(false);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, marginY: -1 }, [0])).toBe(false);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, marginY: 501 }, [0])).toBe(false);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, marginX: 501 }, [0])).toBe(false);
    expect(canRunHeaderFooter({ ...HEADER_FOOTER, marginX: 500 }, [0])).toBe(true);
  });

  it('keeps the desktop margin range', () => {
    expect(MARK_LIMITS.margin).toEqual({ min: 0, max: 500 });
  });
});

describe('canRunWatermark and canRunBackground', () => {
  it('refuses blank watermark text, no pages, and an opacity outside 0.05 to 1', () => {
    expect(canRunWatermark(WATERMARK, [0])).toBe(true);
    expect(canRunWatermark({ ...WATERMARK, text: '   ' }, [0])).toBe(false);
    expect(canRunWatermark(WATERMARK, [])).toBe(false);
    expect(canRunWatermark({ ...WATERMARK, opacity: 1.5 }, [0])).toBe(false);
    expect(canRunWatermark({ ...WATERMARK, opacity: 0 }, [0])).toBe(false);
    expect(canRunWatermark({ ...WATERMARK, opacity: 0.04 }, [0])).toBe(false);
    expect(canRunWatermark({ ...WATERMARK, opacity: 0.05 }, [0])).toBe(true);
  });

  it('refuses a size outside 6 to 400 and an angle outside -180 to 180', () => {
    expect(canRunWatermark({ ...WATERMARK, fontSize: 5 }, [0])).toBe(false);
    expect(canRunWatermark({ ...WATERMARK, fontSize: 6 }, [0])).toBe(true);
    expect(canRunWatermark({ ...WATERMARK, fontSize: 400 }, [0])).toBe(true);
    expect(canRunWatermark({ ...WATERMARK, fontSize: 401 }, [0])).toBe(false);
    expect(canRunWatermark({ ...WATERMARK, angle: -180 }, [0])).toBe(true);
    expect(canRunWatermark({ ...WATERMARK, angle: 181 }, [0])).toBe(false);
  });

  it('checks the colour, opacity and pages of a background', () => {
    expect(canRunBackground('#ffffff', 1, [0])).toBe(true);
    expect(canRunBackground('white', 1, [0])).toBe(false);
    expect(canRunBackground('#ffffff', 0, [0])).toBe(false);
    expect(canRunBackground('#ffffff', 0.05, [0])).toBe(true);
    expect(canRunBackground('#ffffff', 1, [])).toBe(false);
  });
});

describe('listMarks and getMark', () => {
  it('returns the kinds the engine reports', async () => {
    const calls: unknown[] = [];
    const rpc = {
      call: (method: string, params: unknown) => {
        calls.push([method, params]);
        return Promise.resolve({
          items: [{ kind: 'Bates', pages: 2, foreign: false }],
        });
      },
    } as unknown as PageRpc;
    await expect(listMarks(rpc, 'h1')).resolves.toEqual([
      { kind: 'Bates', pages: 2, foreign: false },
    ]);
    expect(calls).toEqual([['marks.list', { handle: 'h1' }]]);
  });

  it('reads one kind with marks.get', async () => {
    const calls: unknown[] = [];
    const rpc = {
      call: (method: string, params: unknown) => {
        calls.push([method, params]);
        return Promise.resolve({ found: false });
      },
    } as unknown as PageRpc;
    await expect(getMark(rpc, 'h1', 'Watermark')).resolves.toEqual({ found: false });
    expect(calls).toEqual([['marks.get', { handle: 'h1', kind: 'Watermark' }]]);
  });
});

const NOT_FOUND: MarkDetailResult = {
  found: false,
  pages: [],
  ranges: '',
  foreign: false,
  header_footer: null,
  watermark: null,
  background: null,
  font_dropped: false,
};

describe('fromMarkDetail', () => {
  it('returns nothing when the kind is not in the document', () => {
    expect(fromMarkDetail(NOT_FOUND)).toBeUndefined();
  });

  it('fills the header & footer form from the stored settings', () => {
    const pre = fromMarkDetail({
      ...NOT_FOUND,
      found: true,
      pages: [0, 1, 3],
      ranges: '1-2, 4',
      header_footer: {
        header_left: '<<file>>',
        header_center: '',
        header_right: '',
        footer_left: '',
        footer_center: '',
        footer_right: 'Page <<page>> of <<pages>>',
        font: 'tiro',
        font_size: 8,
        color: { r: 1, g: 0, b: 0 },
        margin_x: 30,
        margin_top: 20,
        margin_bottom: 20,
        bates_prefix: 'X',
        bates_start: 7,
        bates_digits: 4,
        bates_suffix: '-Y',
      },
    });
    expect(pre?.pages).toEqual([0, 1, 3]);
    expect(pre?.ranges).toBe('1-2, 4');
    expect(pre?.headerFooter).toEqual({
      texts: {
        header_left: '<<file>>',
        header_center: '',
        header_right: '',
        footer_left: '',
        footer_center: '',
        footer_right: 'Page <<page>> of <<pages>>',
      },
      font: 'tiro',
      fontSize: 8,
      color: '#ff0000',
      marginX: 30,
      marginY: 20,
      bates: { prefix: 'X', start: 7, digits: 4, suffix: '-Y' },
    });
    expect(pre?.watermark).toBeUndefined();
    expect(pre?.background).toBeUndefined();
  });

  it('fills the watermark form and keeps the picture note for an image', () => {
    const pre = fromMarkDetail({
      ...NOT_FOUND,
      found: true,
      pages: [0],
      ranges: '1',
      watermark: {
        text: '',
        image: true,
        image_name: 'logo.png',
        font: 'hebo',
        font_size: 60,
        color: { r: 0, g: 0, b: 0 },
        opacity: 0.3,
        angle: 45,
        scale: 0.5,
        on_top: false,
      },
    });
    expect(pre?.watermark).toEqual({
      form: {
        text: '',
        font: 'hebo',
        fontSize: 60,
        color: '#000000',
        opacity: 0.3,
        angle: 45,
        onTop: false,
      },
      image: true,
      imageName: 'logo.png',
      scale: 0.5,
    });
  });

  it('fills the background form and passes the font note through', () => {
    const pre = fromMarkDetail({
      ...NOT_FOUND,
      found: true,
      pages: [0],
      ranges: '1',
      font_dropped: true,
      background: { color: { r: 1, g: 1, b: 0.9 }, opacity: 1 },
    });
    // 0.9 of a channel is 229.5, rounded to e6.
    expect(pre?.background).toEqual({ color: '#ffffe6', opacity: 1 });
    expect(pre?.fontDropped).toBe(true);
  });
});

describe('the token help text', () => {
  it('lists the engine tokens and no {…} placeholders', () => {
    const help = EN['marks.hf.tokens'];
    expect(help).toContain('<<page>>');
    expect(help).toContain('<<bates>>');
    expect(help).not.toMatch(/\{[^}]*\}/);
  });
});

describe('runMark', () => {
  it('starts an action job with the mark action name and its arguments', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const engine: ActionJobEngine = {
      call: (method, params) => {
        calls.push({ method, params });
        // Stop the job at prepare: the test checks the request, not the job.
        return Promise.reject(new Error('stop'));
      },
    };
    const args = watermarkArgs(WATERMARK, [0], false);
    await expect(
      runMark({ engine, startWorker: () => ({}) as never }, 'h1', WATERMARK_ACTION, args),
    ).rejects.toThrow('stop');
    expect(calls).toEqual([
      {
        method: 'jobs.prepare',
        params: { handle: 'h1', job: 'action', args: { name: WATERMARK_ACTION, args } },
      },
    ]);
  });

  it('exports the four action names the engine registers', () => {
    expect([HEADER_FOOTER_ACTION, WATERMARK_ACTION, BACKGROUND_ACTION, REMOVE_ACTION]).toEqual([
      'marks.header_footer',
      'marks.watermark',
      'marks.background',
      'marks.remove',
    ]);
  });
});
