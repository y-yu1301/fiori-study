using { e.header.edit as db } from '../db/schema';

service WorkItemService {
  @odata.draft.enabled
  entity WorkItems as projection on db.WorkItems {
    *,
    // DB上の関連テーブルは追加せず、同じWorkItemsを別投影として一覧表示します。
    bulkEditItems : Association to many WorkItemBulkItems on bulkEditItems.ID = bulkEditItems.ID
  };

  entity WorkItemBulkItems as projection on db.WorkItems;
}

annotate WorkItemService.WorkItems with @(
  UI.CreateHidden: true,
  UI.DeleteHidden: true,
  Capabilities.UpdateRestrictions.Updatable: true,
  Capabilities.SearchRestrictions.Searchable: false,

  UI.SelectionFields: [ location, businessDate, status ],

  UI.LineItem: [
    { Value: name,            Label: '{i18n>item_name}' },
    { Value: location,        Label: '{i18n>item_location}' },
    { Value: businessDate,    Label: '{i18n>item_businessDate}' },
    { Value: status,          Label: '{i18n>item_status}' },
    { Value: assignee,        Label: '{i18n>item_assignee}' },
    { Value: plannedQuantity, Label: '{i18n>item_plannedQuantity}' },
    { Value: actualQuantity,  Label: '{i18n>item_actualQuantity}' },
    { Value: comment,         Label: '{i18n>item_comment}' }
  ],

  UI.HeaderInfo: {
    TypeName      : '{i18n>item_typeName}',
    TypeNamePlural: '{i18n>item_typeNamePlural}',
    Title         : { Value: searchLocation },
    Description   : { Value: searchPeriod }
  },

  UI.FieldGroup #SearchCondition: {
    Data: [
      { $Type: 'UI.DataField', Value: searchLocation, Label: '{i18n>search_location}' },
      { $Type: 'UI.DataField', Value: searchPeriod,   Label: '{i18n>search_period}' },
      { $Type: 'UI.DataField', Value: searchStatus,   Label: '{i18n>search_status}' }
    ]
  },

  UI.HeaderFacets: [{
    $Type : 'UI.ReferenceFacet',
    Label : '{i18n>search_condition}',
    Target: '@UI.FieldGroup#SearchCondition'
  }],

  UI.Facets: [{
    $Type : 'UI.ReferenceFacet',
    Label : '{i18n>bulk_edit_items}',
    Target: 'bulkEditItems/@UI.LineItem'
  }]
);

annotate WorkItemService.WorkItemBulkItems with @(
  Capabilities.UpdateRestrictions.Updatable: true,
  UI.LineItem: [
    { Value: name,            Label: '{i18n>item_name}' },
    { Value: location,        Label: '{i18n>item_location}' },
    { Value: businessDate,    Label: '{i18n>item_businessDate}' },
    { Value: status,          Label: '{i18n>item_status}' },
    { Value: assignee,        Label: '{i18n>item_assignee}' },
    { Value: plannedQuantity, Label: '{i18n>item_plannedQuantity}' },
    { Value: actualQuantity,  Label: '{i18n>item_actualQuantity}' },
    { Value: comment,         Label: '{i18n>item_comment}' }
  ]
);
