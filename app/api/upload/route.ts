import { writeFile, mkdir } from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { randomUUID } from "crypto";

export const config = { api: { bodyParser: false } };

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  const type = (formData.get("type") as string) || "video";

  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const uploadDir = path.join("/tmp/reel_studio", "uploads");
  await mkdir(uploadDir, { recursive: true });

  const ext = file.name.split(".").pop();
  const filename = `${type}_${randomUUID()}.${ext}`;
  const filepath = path.join(uploadDir, filename);

  const bytes = await file.arrayBuffer();
  await writeFile(filepath, Buffer.from(bytes));

  return NextResponse.json({ path: filepath, name: file.name });
}
