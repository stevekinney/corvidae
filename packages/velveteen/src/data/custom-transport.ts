/** A custom value transport supplied by an application `src/transport.ts`. */
export type Transporter<Encoded = unknown, Value = unknown> = {
  /** Return false when this transporter does not recognize the value. */
  encode(value: Value): false | Encoded;
  decode(value: Encoded): Value;
};

export type Transport = Record<string, Transporter>;

/** Custom tags are isolated from devalue's built-in tags and our Promise tag. */
export const transportTag = (name: string) => {
  if (!name || name.includes("\0")) throw new Error("Invalid transport name");
  return `velveteen:transport:${encodeURIComponent(name)}`;
};

/** Adapt Kit-style application transporters to devalue's reducer map. */
export function transportReducers(transport: Transport = {}) {
  return Object.fromEntries(
    Object.entries(transport).map(([name, transporter]) => [
      transportTag(name),
      (value: unknown) => {
        const encoded = transporter.encode(value);
        // Devalue treats falsy reducer results as misses. A matched value is always wrapped.
        return encoded === false ? false : [encoded];
      },
    ]),
  );
}

/** Adapt Kit-style application transporters to devalue's reviver map. */
export function transportRevivers(transport: Transport = {}) {
  return Object.fromEntries(
    Object.entries(transport).map(([name, transporter]) => [
      transportTag(name),
      (value: unknown) => {
        if (!Array.isArray(value) || value.length !== 1)
          throw new Error(`Invalid transport payload for ${name}`);
        return transporter.decode(value[0]);
      },
    ]),
  );
}
