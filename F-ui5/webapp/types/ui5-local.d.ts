declare module "sap/ui/core/mvc/ControllerExtension" {
  export default class ControllerExtension {
    static extend(name: string, implementation: object): unknown;
  }
}

declare module "sap/ui/model/Filter" {
  export default class Filter {
    constructor(settings: object);
  }
}

declare module "sap/ui/model/FilterOperator" {
  const FilterOperator: {
    EQ: string;
    GE: string;
    LE: string;
  };
  export default FilterOperator;
}

declare module "sap/ui/base/Event" {
  export default class Event {
    getParameter(name: string): unknown;
  }
}
