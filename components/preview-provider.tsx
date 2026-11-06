"use client";

import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";
import type { AppData, Project, User } from "@/lib/preview-types";

export const previewUser: User = { id: "preview-creator", name: "Creator", email: "", color: "purple" };
const createdAt = "2026-11-06T09:00:00.000Z";
const samples: Project[] = [
  { id: "space", title: "A little space to dream", genre: "Sci-fi", theme: "space", description: "A small astronaut. A very big universe. And a friendship written in the stars.", state: "draft", filled: 2 },
  { id: "ramen", title: "One more bowl", genre: "Slice of life", theme: "ramen", description: "Late nights, warm bowls, and the people who make a city feel like home.", state: "review", filled: 4 },
  { id: "garden", title: "The garden next door", genre: "Fantasy", theme: "garden", description: "Some things grow a little differently when you give them room to surprise you.", state: "published", filled: 4 },
].map((sample, index) => ({
  id: sample.id, title: sample.title, genre: sample.genre, theme: sample.theme,
  description: sample.description, state: sample.state as Project["state"],
  ownerId: previewUser.id, sample: true, revision: 1, version: sample.state === "draft" ? 0 : 1,
  members: [
    { userId: previewUser.id, name: "Creator", role: "Illustrator", share: 6000 },
    { userId: `sample-${index}`, name: ["Jamie Lee", "Sam Rivera", "Morgan Chen"][index], role: "Writer", share: 4000 },
  ],
  panels: Array.from({ length: 4 }, (_, panel) => ({
    image: panel < sample.filled ? `/art/${sample.theme}.svg` : "",
    dialogue: panel < sample.filled ? ["Every story starts with a little curiosity.", "And a little room for the unexpected.", "Some things are better when we make them together.", "This is only the beginning."][panel] : "",
    alt: `${sample.genre} illustration, sample panel ${panel + 1}`,
  })),
  approvals: [], terms: "Sample artwork for this interface preview. No purchase or publication is taking place.",
  rosterFrozen: sample.state !== "draft", createdAt, updatedAt: createdAt,
  publishedAt: sample.state === "published" ? createdAt : undefined,
  events: [{ id: `sample-event-${index}`, text: "Sample story added to the design preview.", at: createdAt }],
  priceWei: "1000000000000000",
}));

function initialData(): AppData {
  return { user: previewUser, projects: structuredClone(samples), comics: structuredClone(samples.filter(p => p.state === "published")), invitations: [] };
}

const PreviewContext = createContext<{ data: AppData; setData: Dispatch<SetStateAction<AppData>> } | null>(null);

export function PreviewProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState(initialData);
  return <PreviewContext.Provider value={{ data, setData }}>{children}</PreviewContext.Provider>;
}

export function usePreview() {
  const value = useContext(PreviewContext);
  if (!value) throw new Error("PreviewProvider is missing");
  return value;
}
