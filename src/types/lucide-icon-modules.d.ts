declare module "lucide-react/dist/esm/icons/*.js" {
  import type {
    ForwardRefExoticComponent,
    RefAttributes,
    SVGProps,
  } from "react";

  type DirectLucideIconProps = RefAttributes<SVGSVGElement>
    & Partial<SVGProps<SVGSVGElement>>
    & {
      size?: string | number;
      absoluteStrokeWidth?: boolean;
    };

  const Icon: ForwardRefExoticComponent<
    Omit<DirectLucideIconProps, "ref"> & RefAttributes<SVGSVGElement>
  >;
  export default Icon;
}
