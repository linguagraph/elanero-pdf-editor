// Decodes the change events of a reply (W1.2 section 7). The generated decoders check each event's
// fields; this file reads the `kind` key, picks the decoder, and adds the key back. An event that
// does not match makes the whole reply INTERNAL, the same as a bad result (see client.ts).
import {
  EVENT_DECODERS,
  EVENT_KINDS,
  type EventPayloads,
  type RpcEvent,
  type RpcEventKind,
} from './generated';
import { type DecodeContext, expectArray, expectObject, expectOneOf, field } from './shape';

// The decoders check the fields by name and reject any key they do not list, so the `kind` key is
// taken out before a payload is decoded. Each decoder's result is checked by the decoder itself.
function decodeEvent(value: unknown, ctx: DecodeContext, path: string): RpcEvent {
  const o = expectObject(value, path);
  const kind: RpcEventKind = expectOneOf(field(o, 'kind', path), EVENT_KINDS, `${path}.kind`);
  const payload: Record<string, unknown> = { ...o };
  delete payload.kind;
  const decode = EVENT_DECODERS[kind] as (
    value: unknown,
    ctx: DecodeContext,
    path: string,
  ) => EventPayloads[RpcEventKind];
  // The fields were checked by the decoder for this kind; the kind is the one it was read from.
  return { kind, ...decode(payload, ctx, path) } as RpcEvent;
}

// The events list of a reply. An empty list is valid; a bad entry fails the whole list.
export function decodeEvents(value: unknown, ctx: DecodeContext, path: string): RpcEvent[] {
  return expectArray(value, path).map((item, index) => decodeEvent(item, ctx, `${path}[${index}]`));
}
