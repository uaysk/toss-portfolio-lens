import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, buttonVariants } from "./button";

describe("Button", () => {
  it("applies the default classes without a variant dependency", () => {
    const classes = buttonVariants();

    expect(classes).toContain("bg-primary");
    expect(classes).toContain("h-11");
  });

  it("preserves variants, sizes, and Tailwind class overrides", () => {
    const classes = buttonVariants({
      variant: "ghost",
      size: "sm",
      className: "h-20",
    });

    expect(classes).toContain("text-foreground");
    expect(classes).toContain("text-xs");
    expect(classes).toContain("h-20");
    expect(classes).not.toContain("h-9");
  });

  it("keeps the asChild composition behavior", () => {
    const markup = renderToStaticMarkup(
      <Button asChild variant="secondary">
        <a href="/report">Open report</a>
      </Button>,
    );

    expect(markup).toContain('<a href="/report"');
    expect(markup).toContain("bg-secondary");
    expect(markup).not.toContain("<button");
  });
});
