import { json } from "@sveltejs/kit";
import { readVelveteenTestEnvironment } from "../../../../environment-configuration.js";

export const GET = () =>
  json({
    status: readVelveteenTestEnvironment().endpointStatus ?? "ok",
  });
