import "server-only";
// Keep the reference backend's full decode and metadata-stripping validation.
import sharp from "sharp";
import { AppError, ensure, text } from "./store";

export async function validateImage(value: unknown): Promise<string> {
  const image = text(value, 3_500_000, "Panel image", false);
  if (!image) return "";
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  ensure(match, "Upload a PNG or JPEG image.");
  try {
    const input = sharp(Buffer.from(match[2], "base64"), { limitInputPixels: 20_000_000, failOn: "warning" });
    const metadata = await input.metadata();
    ensure(metadata.format === match[1] && (metadata.pages || 1) === 1, "Use a single PNG or JPEG image.");
    const normalized = await input.rotate()
      .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 86 }).toBuffer();
    return `data:image/jpeg;base64,${normalized.toString("base64")}`;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("This image could not be opened. Upload a valid PNG or JPEG under 20 megapixels.");
  }
}
