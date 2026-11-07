import "server-only";
import sharp from "sharp";

/** Returns one-based page numbers for images with almost no colour variation. */
export async function blankPages(pages: { image: string }[]): Promise<number[]> {
  const blank: number[] = [];
  for (const [i, page] of pages.entries()) {
    const image = page.image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    const stats = await sharp(Buffer.from(image, "base64")).stats();
    if (stats.channels.every(channel => channel.stdev < 1.5)) blank.push(i + 1);
  }
  return blank;
}
