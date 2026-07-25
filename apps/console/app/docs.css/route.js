import { serveAdminFile } from "../../lib/admin-static";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return serveAdminFile("docs.css");
}
