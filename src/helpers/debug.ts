// This security fork does not emit provider diagnostics. Upstream debug callers
// include financial identifiers, request URLs and raw exception objects.
export function getDebug(_name: string) {
  void _name;
  return (..._args: unknown[]) => {
    void _args;
  };
}
