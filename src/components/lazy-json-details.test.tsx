import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LazyJsonDetails } from "./lazy-json-details";

describe("LazyJsonDetails", () => {
  it("keeps a closed large artifact out of the rendered markup", () => {
    const marker = "large-artifact-value-that-should-stay-lazy";
    const markup = renderToStaticMarkup(
      <LazyJsonDetails value={{ rows: Array.from({ length: 1_000 }, () => marker) }} />,
    );

    expect(markup).toContain("원본 수치 결과 보기");
    expect(markup).not.toContain(marker);
    expect(markup).not.toContain("<pre");
  });
});
