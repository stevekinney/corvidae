import { json } from "@sveltejs/kit";

export const GET = () =>
  json({ status: process.env.VELVETEEN_ENDPOINT_STATUS ?? "ok" });
