/** Only product destinations may survive authentication. Never accept a URL. */
export function studioReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024) return '/app';
  const [path, search, extra] = value.split('?');
  const galleryPath =
    /^\/(e|proofing|highlights|questionnaires|proposals)\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}(\/wall)?$/.exec(
      path ?? '',
    );
  const validGallery =
    galleryPath && (!galleryPath[2] || galleryPath[1] === 'highlights');
  const validQuestionnaires =
    /^\/app\/projects\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\/(?:questionnaires|proposals)$/.test(
      path ?? '',
    );
  if (
    extra !== undefined ||
    !path ||
    (!validGallery &&
      !validQuestionnaires &&
      !/^\/app(?:\/(?:library|clients|enquiries|services|expenses|portfolio|credits|projects|work|schedule|duplicates|import|settings|billing|discover\/new|events(?:\/(?:[A-Za-z0-9_-]+))?))?\/?$/.test(
        path,
      ))
  )
    return '/app';
  if (search === undefined) return path;
  const params = new URLSearchParams(search);
  const entries = [...params.entries()];
  if (entries.length !== 1) return '/app';
  const [key, parameter] = entries[0]!;
  const eventImport =
    path.replace(/\/$/, '') === '/app/import' &&
    key === 'eventId' &&
    /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
      parameter,
    );
  const billing =
    path.replace(/\/$/, '') === '/app/billing' &&
    key === 'context' &&
    ['personal', 'organizer'].includes(parameter);
  return eventImport || billing ? `${path}?${params.toString()}` : '/app';
}
