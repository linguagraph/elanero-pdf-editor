import { describe, expect, it } from 'vitest';
import type { DocInfo } from '../rpc/generated';
import {
  changedFields,
  editableValues,
  MAX_FIELD_LENGTH,
  metadataArgs,
  overLongFields,
} from './metadata';

const info: DocInfo = {
  encrypted: false,
  has_signatures: false,
  page_count: 3,
  title: 'Report',
  author: 'Finance',
  subject: '',
  keywords: 'q3, draft',
  creator: 'Writer',
  producer: 'PDF library',
  creation_date: 'D:20240101120000',
  mod_date: 'D:20240102120000',
  pdf_version: '1.7',
  is_tagged: false,
  has_forms: false,
  has_javascript: false,
  is_repaired: false,
  has_xmp: false,
};

describe('changed fields', () => {
  it('sends only the fields whose value differs', () => {
    const original = editableValues(info);
    expect(changedFields(original, { ...original, author: 'Legal' })).toEqual({ author: 'Legal' });
  });

  it('is empty when nothing changed', () => {
    const original = editableValues(info);
    expect(changedFields(original, { ...original })).toEqual({});
  });

  it('keeps a field cleared to empty as a change', () => {
    const original = editableValues(info);
    expect(changedFields(original, { ...original, keywords: '' })).toEqual({ keywords: '' });
  });
});

describe('length validation', () => {
  it('accepts values up to the limit', () => {
    const edited = { ...editableValues(info), title: 'x'.repeat(MAX_FIELD_LENGTH) };
    expect(overLongFields(edited)).toEqual([]);
  });

  it('names each field that is one character too long, in dialog order', () => {
    const long = 'x'.repeat(MAX_FIELD_LENGTH + 1);
    const edited = { ...editableValues(info), subject: long, title: long };
    expect(overLongFields(edited)).toEqual(['title', 'subject']);
  });
});

describe('metadata arguments', () => {
  it('carries every Info field, with the changed ones replaced', () => {
    expect(metadataArgs(info, { author: 'Legal' })).toEqual({
      title: 'Report',
      author: 'Legal',
      subject: '',
      keywords: 'q3, draft',
      creator: 'Writer',
      producer: 'PDF library',
      creation_date: 'D:20240101120000',
      mod_date: 'D:20240102120000',
    });
  });
});
