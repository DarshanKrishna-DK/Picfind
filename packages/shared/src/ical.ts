export function calendarText(value: string) {
  const escaped = value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n');
  return [...escaped]
    .filter((point) => {
      const code = point.codePointAt(0)!;
      return (code >= 32 && code !== 127) || code === 9;
    })
    .join('')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}
export function foldCalendarLine(line: string) {
  const encoder = new TextEncoder();
  let result = '',
    bytes = 0;
  for (const point of line) {
    const length = encoder.encode(point).byteLength;
    if (bytes + length > 75) {
      result += '\r\n ';
      bytes = 1;
    }
    result += point;
    bytes += length;
  }
  return result;
}
export function calendarStamp(value: string) {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}
