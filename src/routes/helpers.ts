import type { FastifyReply } from "fastify";

export type Body = Record<string, any>;

export function missingFields(body: Body, fields: string[]): string[] {
  return fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
}

export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: "invalid_request", message });
}
