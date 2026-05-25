import type {HTMLAttributes} from 'react';

interface MediaAssetProps extends HTMLAttributes<HTMLElement> {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  mutedVideo?: boolean;
}

function extensionFromUrl(src: string): string {
  const clean = src.split('#', 1)[0]?.split('?', 1)[0] ?? src;
  const idx = clean.lastIndexOf('.');
  return idx >= 0 ? clean.slice(idx).toLowerCase() : '';
}

export function isVideoAsset(src: string | null | undefined): boolean {
  if (!src) return false;
  const ext = extensionFromUrl(src);
  return ext === '.webm' || ext === '.mp4';
}

export function isAudioAsset(src: string | null | undefined): boolean {
  if (!src) return false;
  const ext = extensionFromUrl(src);
  return ext === '.mp3' || ext === '.ogg' || ext === '.m4a' || ext === '.wav';
}

export function MediaAsset({
  src,
  alt = '',
  className,
  mutedVideo = true,
  ...rest
}: MediaAssetProps) {
  if (!src) return null;
  if (isVideoAsset(src)) {
    return (
      <video
        className={className}
        src={src}
        muted={mutedVideo}
        autoPlay
        loop
        playsInline
        preload="metadata"
        aria-label={alt || undefined}
        {...rest}
      />
    );
  }
  if (isAudioAsset(src)) {
    return <audio className={className} src={src} controls preload="metadata" />;
  }
  return <img className={className} src={src} alt={alt} {...rest} />;
}

