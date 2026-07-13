export function BrandLogo() {
  return (
    <picture className="brandLogoPicture">
      <source
        type="image/webp"
        srcSet="/logo-40.webp 1x, /logo-80.webp 2x, /logo-120.webp 3x"
      />
      <img
        className="brandLogo"
        src="/logo-40.png"
        srcSet="/logo-40.png 1x, /logo-80.png 2x, /logo-120.png 3x"
        width={40}
        height={40}
        alt=""
        decoding="async"
      />
    </picture>
  );
}
