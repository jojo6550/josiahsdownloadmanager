// MIME type → file extension map. Covers popular media, docs, archives, code, executables.
const MIME_TO_EXT = {
  // Audio
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'weba',
  'audio/x-ms-wma': 'wma',
  'audio/midi': 'mid',
  'audio/x-midi': 'mid',

  // Video
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/x-ms-wmv': 'wmv',
  'video/mpeg': 'mpg',
  'video/3gpp': '3gp',
  'video/x-m4v': 'm4v',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',

  // Images
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',

  // Documents
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/epub+zip': 'epub',
  'application/x-mobipocket-ebook': 'mobi',

  // Archives
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-bzip2': 'bz2',
  'application/x-xz': 'xz',

  // Code / data
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/css': 'css',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/yaml': 'yaml',
  'text/yaml': 'yaml',

  // Executables / installers
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/x-apple-diskimage': 'dmg',
  'application/x-debian-package': 'deb',
  'application/x-rpm': 'rpm',
  'application/vnd.android.package-archive': 'apk',
  'application/x-iso9660-image': 'iso',

  // Fonts
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',

  // Other
  'application/x-bittorrent': 'torrent',
  'application/octet-stream': 'bin',
};

function extFromMime(mime) {
  if (!mime) return null;
  const clean = mime.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[clean] || null;
}

module.exports = { MIME_TO_EXT, extFromMime };
