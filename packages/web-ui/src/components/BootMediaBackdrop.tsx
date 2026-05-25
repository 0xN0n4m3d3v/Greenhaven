interface Props {
  videoUrl?: string | null;
}

export function BootMediaBackdrop({videoUrl}: Props) {
  if (videoUrl) {
    return (
      <video
        key={videoUrl}
        className="title-screen__video"
        src={videoUrl}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
      />
    );
  }

  return <div className="title-screen__bg" aria-hidden="true" />;
}
