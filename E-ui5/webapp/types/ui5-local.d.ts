declare module "sap/ui/core/mvc/ControllerExtension" {
  export default class ControllerExtension {
    static extend(name: string, implementation: object): unknown;
  }
}

declare module "sap/ui/model/Filter" {
  export default class Filter {}
}

declare module "sap/ui/base/Event" {
  export default class Event {
    getParameter(name: string): unknown;
  }
}
