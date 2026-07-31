import React, { useEffect, useState } from 'react';

export default function CardImage({ src, alt = '', className = '', fallbackLabel = 'Missing image', ...props }) {
  const [imageFailed, setImageFailed] = useState(!src);

  useEffect(() => {
    setImageFailed(!src);
  }, [src]);

  if (imageFailed) {
    return (
      <div
        role="img"
        aria-label={alt || fallbackLabel}
        className={`flex h-full w-full items-center justify-center bg-rift-800 px-1 text-center text-[8px] font-medium uppercase tracking-wide text-rift-400 ${className}`}
      >
        {fallbackLabel}
      </div>
    );
  }

  return (
    <img
      {...props}
      src={src}
      alt={alt}
      className={className}
      onError={() => setImageFailed(true)}
    />
  );
}
