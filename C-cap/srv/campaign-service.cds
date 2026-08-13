using { c.filter.edit as db } from '../db/schema';

service CampaignService {

  @odata.draft.enabled
  entity Campaigns as projection on db.Campaigns {
    *,
    bulkEditItems : Association to many CampaignBulkItems on bulkEditItems.ID = bulkEditItems.ID
  };

  entity CampaignBulkItems as projection on db.Campaigns;
}

annotate CampaignService.Campaigns with @(
  UI.CreateHidden: true,
  UI.DeleteHidden: true,
  Capabilities.UpdateRestrictions.Updatable: true,

  UI.SelectionFields: [
    targetDate,
    keyword,
    status,
    assignee
  ],

  UI.LineItem: [
    { Value: name,            Label: '{i18n>campaign_name}' },
    { Value: keyword,         Label: '{i18n>campaign_keyword}' },
    { Value: targetDate,      Label: '{i18n>campaign_targetDate}' },
    { Value: status,          Label: '{i18n>campaign_status}' },
    { Value: assignee,        Label: '{i18n>campaign_assignee}' },
    { Value: plannedQuantity, Label: '{i18n>campaign_plannedQuantity}' },
    { Value: actualQuantity,  Label: '{i18n>campaign_actualQuantity}' },
    { Value: comment,         Label: '{i18n>campaign_comment}' },
    { Value: filterNote,      Label: '{i18n>campaign_filterNote}' }
  ],

  UI.HeaderInfo: {
    TypeName      : '{i18n>campaign_typeName}',
    TypeNamePlural: '{i18n>campaign_typeNamePlural}',
    Title         : { Value: name },
    Description   : { Value: keyword }
  },

  UI.Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      Target: 'bulkEditItems/@UI.LineItem'
    }
  ]
);

annotate CampaignService.CampaignBulkItems with @(
  Capabilities.UpdateRestrictions.Updatable: true,

  UI.LineItem: [
    { Value: name,            Label: '{i18n>campaign_name}' },
    { Value: keyword,         Label: '{i18n>campaign_keyword}' },
    { Value: targetDate,      Label: '{i18n>campaign_targetDate}' },
    { Value: status,          Label: '{i18n>campaign_status}' },
    { Value: assignee,        Label: '{i18n>campaign_assignee}' },
    { Value: plannedQuantity, Label: '{i18n>campaign_plannedQuantity}' },
    { Value: actualQuantity,  Label: '{i18n>campaign_actualQuantity}' },
    { Value: comment,         Label: '{i18n>campaign_comment}' },
    { Value: filterNote,      Label: '{i18n>campaign_filterNote}' }
  ]
);
