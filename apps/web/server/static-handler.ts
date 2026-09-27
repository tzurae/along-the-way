import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function isFile(filePath: string) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createStaticHandler(root: string) {
  const publicRoot = path.resolve(root);

  return async function handleStaticRequest(request: Request) {
    const url = new URL(request.url);
    let pathname: string;

    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
    const resolvedPath = path.resolve(publicRoot, requestedPath);
    const isInsideRoot =
      resolvedPath === publicRoot ||
      resolvedPath.startsWith(`${publicRoot}${path.sep}`);

    if (!isInsideRoot) {
      return notFound();
    }

    const isVersionedAsset = pathname.startsWith("/assets/");
    let responsePath = resolvedPath;

    if (!(await isFile(responsePath))) {
      if (isVersionedAsset || path.extname(pathname) !== "") {
        return notFound();
      }
      responsePath = path.join(publicRoot, "index.html");
    }

    if (!(await isFile(responsePath))) {
      return notFound();
    }

    return new Response(await readFile(responsePath), {
      headers: {
        "Cache-Control": isVersionedAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "Content-Type":
          contentTypes[path.extname(responsePath).toLowerCase()] ??
          "application/octet-stream",
      },
    });
  };
}
