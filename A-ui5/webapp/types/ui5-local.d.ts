declare module "sap/ui/core/mvc/ControllerExtension" {
  export default class ControllerExtension {
    static extend(name: string, implementation: object): unknown;
  }
}

declare module "sap/ui/model/Filter" {
  export default class Filter {
    constructor(settings: {
      path: string;
      operator: string;
      value1?: string | number | boolean;
      value2?: string | number | boolean;
    });
  }
}

declare module "sap/ui/model/odata/v4/Context" {
  export default class Context {
    getPath(): string;
  }
}

declare module "sap/ui/core/routing/HashChanger" {
  export default class HashChanger {
    static getInstance(): HashChanger;
    getHash(): string;
  }
}

declare module "sap/ui/base/Event" {
  export default class Event {
    getParameter(name: string): unknown;
  }
}

declare module "sap/ui/model/json/JSONModel" {
  export default class JSONModel {
    constructor(data?: object);
    setData(data: object): void;
  }
}
