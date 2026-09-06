using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using BarsaAgent.Models;
using BarsaAgent.Services;

namespace BarsaAgent.Forms;

public class MappingForm : Form
{
    private readonly string _serviceUrl;
    private readonly string _apiKeyHeaderName;
    private readonly string _apiKeyValue;
    private readonly IssueService _issueService;

    private TextBox _txtRootPath = null!;
    private Button _btnFetchSample = null!;
    private TextBox _txtSample = null!;
    private ComboBox _cmbIdPath = null!;
    private ComboBox _cmbTitlePath = null!;
    private ComboBox _cmbDescriptionPath = null!;
    private ComboBox _cmbAcceptanceCriteriaPath = null!;
    private ComboBox _cmbSlugPath = null!;
    private RadioButton _rbArrayField = null!;
    private RadioButton _rbSplitText = null!;
    private TextBox _txtDelimiter = null!;
    private Button _btnOk = null!;
    private Button _btnCancel = null!;
    private ToolStripStatusLabel _statusLabel = null!;
    private ToolStripStatusLabel _statusTimeLabel = null!;

    public string ResultRootPath { get; private set; } = "";
    public FieldMapping ResultMapping { get; private set; } = new();

    public MappingForm(
        string serviceUrl,
        string apiKeyHeaderName,
        string apiKeyValue,
        string rootPath,
        FieldMapping existingMapping,
        IssueService issueService)
    {
        _serviceUrl = serviceUrl;
        _apiKeyHeaderName = apiKeyHeaderName;
        _apiKeyValue = apiKeyValue;
        _issueService = issueService;

        BuildUi();
        _txtRootPath.Text = rootPath;
        _cmbIdPath.Text = existingMapping.IdPath;
        _cmbTitlePath.Text = existingMapping.TitlePath;
        _cmbDescriptionPath.Text = existingMapping.DescriptionPath;
        _cmbAcceptanceCriteriaPath.Text = existingMapping.AcceptanceCriteriaPath;
        _cmbSlugPath.Text = existingMapping.SlugPath;
        _txtDelimiter.Text = string.IsNullOrEmpty(existingMapping.AcceptanceCriteriaDelimiter)
            ? "\n"
            : existingMapping.AcceptanceCriteriaDelimiter;

        _rbArrayField.Checked = existingMapping.AcceptanceCriteriaMode == AcceptanceCriteriaMode.ArrayField;
        _rbSplitText.Checked = !_rbArrayField.Checked;
        UpdateDelimiterEnabled();
        Shown += (_, _) => SetStatus("Ready to fetch a sample response.");
    }

    private void BuildUi()
    {
        Text = "Configure issue field mapping";
        Width = 820;
        Height = 750;
        MinimumSize = new Size(760, 680);
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        UiTheme.ApplyForm(this);

        var statusStrip = UiTheme.CreateStatusStrip(out _statusLabel, out _statusTimeLabel);
        Controls.Add(statusStrip);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18, 14, 18, 14),
            ColumnCount = 1,
            RowCount = 5,
            BackColor = UiTheme.WindowBackground
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 92F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 190F));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 92F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 50F));

        root.Controls.Add(BuildSourcePanel(), 0, 0);
        root.Controls.Add(BuildSamplePanel(), 0, 1);
        root.Controls.Add(BuildFieldsPanel(), 0, 2);
        root.Controls.Add(BuildCriteriaPanel(), 0, 3);
        root.Controls.Add(BuildButtonPanel(), 0, 4);
        Controls.Add(root);
        statusStrip.BringToFront();

        AcceptButton = _btnOk;
        CancelButton = _btnCancel;
    }

    private GroupBox BuildSourcePanel()
    {
        var group = UiTheme.CreateGroup("Response source");
        group.Margin = new Padding(0, 0, 0, 8);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, Padding = new Padding(4, 3, 4, 3) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 205F));

        _txtRootPath = new TextBox { Dock = DockStyle.Fill };
        UiTheme.StyleInput(_txtRootPath);
        _btnFetchSample = new Button { Text = "Fetch sample and detect fields", Dock = DockStyle.Fill, Margin = new Padding(8, 4, 0, 4) };
        UiTheme.StylePrimaryButton(_btnFetchSample);
        _btnFetchSample.Click += async (_, _) => await FetchSampleAsync();

        layout.Controls.Add(UiTheme.CreateFieldLabel("Root path (optional)"), 0, 0);
        layout.Controls.Add(_txtRootPath, 1, 0);
        layout.Controls.Add(_btnFetchSample, 2, 0);
        group.Controls.Add(layout);
        return group;
    }

    private GroupBox BuildSamplePanel()
    {
        var group = UiTheme.CreateGroup("Sample item (read-only)");
        group.Margin = new Padding(0, 0, 0, 8);
        _txtSample = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            ReadOnly = true,
            BackColor = Color.FromArgb(17, 24, 39),
            ForeColor = Color.FromArgb(209, 213, 219),
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Cascadia Mono", 9F)
        };
        group.Controls.Add(_txtSample);
        return group;
    }

    private GroupBox BuildFieldsPanel()
    {
        var group = UiTheme.CreateGroup("Field paths");
        group.Margin = new Padding(0, 0, 0, 8);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 5, Padding = new Padding(4, 3, 4, 3) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        for (var i = 0; i < 5; i++)
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 20F));

        _cmbIdPath = AddMappingRow(layout, "ID *", 0);
        _cmbTitlePath = AddMappingRow(layout, "Title *", 1);
        _cmbDescriptionPath = AddMappingRow(layout, "Description", 2);
        _cmbAcceptanceCriteriaPath = AddMappingRow(layout, "Acceptance criteria *", 3);
        _cmbSlugPath = AddMappingRow(layout, "Slug (branch name)", 4);
        group.Controls.Add(layout);
        return group;
    }

    private GroupBox BuildCriteriaPanel()
    {
        var group = UiTheme.CreateGroup("Acceptance criteria format");
        group.Margin = new Padding(0, 0, 0, 8);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1, Padding = new Padding(4, 3, 4, 3) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 205F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 185F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

        _rbSplitText = new RadioButton { Text = "Split a text value", AutoSize = true, Anchor = AnchorStyles.Left, Checked = true };
        _rbArrayField = new RadioButton { Text = "JSON array", AutoSize = true, Anchor = AnchorStyles.Left };
        _rbSplitText.CheckedChanged += (_, _) => UpdateDelimiterEnabled();
        _rbArrayField.CheckedChanged += (_, _) => UpdateDelimiterEnabled();
        _txtDelimiter = new TextBox { Text = "\n", Dock = DockStyle.Fill };
        UiTheme.StyleInput(_txtDelimiter);

        layout.Controls.Add(_rbSplitText, 0, 0);
        layout.Controls.Add(_rbArrayField, 1, 0);
        layout.Controls.Add(UiTheme.CreateFieldLabel("Delimiter"), 2, 0);
        layout.Controls.Add(_txtDelimiter, 3, 0);
        group.Controls.Add(layout);
        return group;
    }

    private Control BuildButtonPanel()
    {
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            Padding = new Padding(0, 5, 0, 0)
        };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 115F));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150F));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        _btnOk = new Button { Text = "Save mapping", Width = 140, Height = 36 };
        UiTheme.StylePrimaryButton(_btnOk);
        _btnOk.Click += (_, _) => OnOk();
        _btnCancel = new Button { Text = "Cancel", Width = 105, Height = 36, DialogResult = DialogResult.Cancel };
        UiTheme.StyleSecondaryButton(_btnCancel);
        _btnCancel.Click += (_, _) => SetStatus("Mapping canceled.");
        panel.Controls.Add(_btnCancel, 1, 0);
        panel.Controls.Add(_btnOk, 2, 0);
        return panel;
    }

    private static ComboBox AddMappingRow(TableLayoutPanel layout, string labelText, int row)
    {
        var combo = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDown };
        UiTheme.StyleInput(combo);
        layout.Controls.Add(UiTheme.CreateFieldLabel(labelText), 0, row);
        layout.Controls.Add(combo, 1, row);
        return combo;
    }

    private void UpdateDelimiterEnabled()
    {
        _txtDelimiter.Enabled = _rbSplitText.Checked;
        if (_statusLabel is not null)
            SetStatus(_rbSplitText.Checked ? "Acceptance criteria will be split using the delimiter." : "Acceptance criteria will be read from a JSON array.");
    }

    private async Task FetchSampleAsync()
    {
        if (string.IsNullOrWhiteSpace(_serviceUrl))
        {
            ShowWarning("Enter the service URL on the main form first.");
            return;
        }

        _btnFetchSample.Enabled = false;
        _btnFetchSample.Text = "Fetching...";
        SetStatus("Fetching a sample response from the service...");
        try
        {
            using var doc = await _issueService.FetchRawAsync(_serviceUrl, _apiKeyHeaderName, _apiKeyValue);
            var sample = _issueService.GetSampleItem(doc, _txtRootPath.Text.Trim());
            if (sample is null)
            {
                SetStatus("No issue array was found. Check the root path.", UiTheme.Error);
                return;
            }

            var item = sample.Value;
            _txtSample.Text = JsonSerializer.Serialize(item, new JsonSerializerOptions { WriteIndented = true });
            var paths = JsonPathHelper.FlattenPaths(item);
            PopulateCombo(_cmbIdPath, paths);
            PopulateCombo(_cmbTitlePath, paths);
            PopulateCombo(_cmbDescriptionPath, paths);
            PopulateCombo(_cmbAcceptanceCriteriaPath, paths);
            PopulateCombo(_cmbSlugPath, paths);
            SetStatus($"Detected {paths.Count} field path(s). Select or type a path for each mapping.", UiTheme.Success);
        }
        catch (Exception ex)
        {
            SetStatus("Sample request failed: " + ex.Message, UiTheme.Error);
        }
        finally
        {
            _btnFetchSample.Enabled = true;
            _btnFetchSample.Text = "Fetch sample and detect fields";
        }
    }

    private static void PopulateCombo(ComboBox combo, List<string> paths)
    {
        var current = combo.Text;
        combo.Items.Clear();
        foreach (var path in paths)
            combo.Items.Add(path);
        combo.Text = current;
    }

    private void OnOk()
    {
        if (string.IsNullOrWhiteSpace(_cmbIdPath.Text) ||
            string.IsNullOrWhiteSpace(_cmbTitlePath.Text) ||
            string.IsNullOrWhiteSpace(_cmbAcceptanceCriteriaPath.Text))
        {
            ShowWarning("ID, Title, and Acceptance Criteria paths are required.");
            DialogResult = DialogResult.None;
            return;
        }

        ResultRootPath = _txtRootPath.Text.Trim();
        ResultMapping = new FieldMapping
        {
            IdPath = _cmbIdPath.Text.Trim(),
            TitlePath = _cmbTitlePath.Text.Trim(),
            DescriptionPath = _cmbDescriptionPath.Text.Trim(),
            AcceptanceCriteriaPath = _cmbAcceptanceCriteriaPath.Text.Trim(),
            AcceptanceCriteriaMode = _rbArrayField.Checked ? AcceptanceCriteriaMode.ArrayField : AcceptanceCriteriaMode.SplitText,
            AcceptanceCriteriaDelimiter = string.IsNullOrEmpty(_txtDelimiter.Text) ? "\n" : _txtDelimiter.Text,
            SlugPath = _cmbSlugPath.Text.Trim()
        };
        SetStatus("Mapping validated and saved.", UiTheme.Success);
        DialogResult = DialogResult.OK;
    }

    private void ShowWarning(string message)
    {
        SetStatus("Validation: " + message, UiTheme.Warning);
        MessageBox.Show(this, message, "Validation", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private void SetStatus(string text, Color? color = null)
    {
        _statusLabel.Text = text;
        _statusLabel.ForeColor = color ?? Color.White;
        _statusTimeLabel.Text = DateTime.Now.ToString("HH:mm:ss");
    }
}
