// The link layer over one page (W5.3). Each link is a transparent, focusable span placed from its
// rect in page points, scaled the way the text layer is scaled, so a link and the text it covers
// line up. A span, not an anchor: a real href would let middle-click and "open in new tab" reach the
// raw address without the checks. Enter follows the link; the pointer follows through the view's tap
// rule (linkTap.ts).
import { useEffect, useMemo, useState } from 'react';
import type { LinkDto } from '../rpc/generated';
import { pageLabelFor } from '../view/navigation';
import { pointsToCss } from '../comments/coordinates';
import { t } from '../i18n/t';
import { classifyLink } from './linkTarget';
import { type LinkCache, sortLinks } from './linkCache';
import './links.css';

export interface PageLinkLayerProps {
  readonly cache: LinkCache;
  readonly page: number;
  // The page revision the layer is asked for; a new revision asks the engine again.
  readonly revision: number;
  readonly zoom: number;
  // The document's page labels (one per page, or none), for the names of the links.
  readonly labels: readonly string[];
  // Called when Enter follows a link. The view decides what following it means.
  readonly onFollow: (link: LinkDto) => void;
}

// The address of a mail link: the mailto path before any '?'. The ?subject= and ?body= query can run
// to any length, so a screen reader does not read it out.
function mailAddress(href: string): string {
  const path = href.replace(/^mailto:/i, '');
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}

// The name a screen reader reads for a link: where it goes, not its visible text. A web link names
// its host and a mail link its address, so a long address does not fill the name.
function nameOf(link: LinkDto, labels: readonly string[]): string {
  const action = classifyLink(link);
  if (action.action === 'goto')
    return t('links.goTo', { label: pageLabelFor(action.page, labels) });
  if (action.action === 'confirm')
    return t('links.web', {
      address: action.scheme === 'mailto:' ? mailAddress(action.href) : action.host,
    });
  if (action.notice === 'malformed') return t('links.invalid');
  if (action.notice === 'noTarget') return t('links.noTarget');
  return t('links.unsupported');
}

// The links read for one page at one revision.
interface Listed {
  readonly page: number;
  readonly revision: number;
  readonly links: readonly LinkDto[];
}

const NO_LINKS: readonly LinkDto[] = [];

export function PageLinkLayer({
  cache,
  page,
  revision,
  zoom,
  labels,
  onFollow,
}: PageLinkLayerProps) {
  // The list is kept with the page and revision it was read for, so a layer asked for another
  // revision shows none until that revision's reply arrives: an older revision's rectangles never stay.
  const [listed, setListed] = useState<Listed | null>(null);
  const links =
    listed !== null && listed.page === page && listed.revision === revision
      ? listed.links
      : NO_LINKS;

  useEffect(() => {
    let active = true;
    cache.get(page, revision).then(
      (reply) => {
        // A reply at another revision is not this page's list: the layer shows none until it has one.
        if (active && reply.revision === revision)
          setListed({ page, revision, links: sortLinks(reply.links) });
      },
      () => {
        // No links for this page: the page still shows, and it has no tab stops for them.
      },
    );
    return () => {
      active = false;
    };
  }, [cache, page, revision]);

  const placed = useMemo(
    () =>
      links.map((link) => ({
        link,
        style: {
          left: pointsToCss(link.rect.x0, zoom),
          top: pointsToCss(link.rect.y0, zoom),
          width: pointsToCss(link.rect.x1 - link.rect.x0, zoom),
          height: pointsToCss(link.rect.y1 - link.rect.y0, zoom),
        },
      })),
    [links, zoom],
  );

  return (
    <div className="page-link-layer">
      {placed.map(({ link, style }, index) => {
        const target = classifyLink(link);
        const title =
          target.action === 'goto'
            ? t('links.title.page', { label: pageLabelFor(target.page, labels) })
            : target.action === 'confirm'
              ? target.scheme === 'mailto:'
                ? mailAddress(target.href)
                : target.href
              : undefined;
        return (
          <span
            key={index}
            role="link"
            tabIndex={0}
            data-link={index}
            className="page-link"
            aria-label={nameOf(link, labels)}
            title={title}
            style={style}
            onKeyDown={(event) => {
              // Only Enter follows a link, as in HTML: Space scrolls the page.
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onFollow(link);
            }}
          />
        );
      })}
    </div>
  );
}
