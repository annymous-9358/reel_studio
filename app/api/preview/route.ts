import { NextRequest } from "next/server";
import { createReadStream, statSync } from "fs";
import { jobs } from "../process/route";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("id");
  if (!jobId || !jobs[jobId]?.output) {
    return new Response("Not ready", { status: 404 });
  }

  const filePath = jobs[jobId].output!;
  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return new Response("File not found", { status: 404 });
  }

  const rangeHeader = req.headers.get("range");

  const makeStream = (start?: number, end?: number) => {
    const nodeStream = createReadStream(filePath, start !== undefined ? { start, end } : undefined);
    return new ReadableStream({
      start(controller) {
        nodeStream.on("data", (chunk) => controller.enqueue(chunk));
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err) => controller.error(err));
      },
      cancel() { nodeStream.destroy(); },
    });
  };

  if (rangeHeader) {
    const [startStr, endStr] = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    return new Response(makeStream(start, end), {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
      },
    });
  }

  return new Response(makeStream(), {
    headers: {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": String(fileSize),
    },
  });
}
