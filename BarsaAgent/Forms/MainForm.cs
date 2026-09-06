using System;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Windows.Forms;
using BarsaAgent.Models;
using BarsaAgent.Services;

namespace BarsaAgent.Forms;

public class MainForm : Form
{
    private readonly HttpClient _httpClient = new();
    private readonly IssueService _issueService;
    private readonly GitWorktreeService _gitService = new();
    private AppConfig _config;

    private TextBox _txtServiceUrl = null!;
    private TextBox _txtApiKeyHeaderName = null!;
    private TextBox _txtApiKeyValue = null!;
    private Label _lblMappingSummary = null!;
    private Button _btnConfigureMapping = null!;
    private TextBox _txtRepoPath = null!;
    private Button _btnBrowseRepo = null!;
    private TextBox _txtWorktreeBasePath = null!;
    private Button _btnBrowseWorktree = null!;
    private TextBox _txtBaseBranch = null!;
    private Button _btnStart = null!;
    private DataGridView _dgvResults = null!;
    private TextBox _txtLog = null!;
    private ToolStripStatusLabel _statusLabel = null!;
    private ToolStripStatusLabel _statusTimeLabel = null!;

    public MainForm()
    {
        _issueService = new IssueService(_httpClient);
        _config = ConfigStore.Load();
        BuildUi();
        LoadConfigIntoUi();

        Shown += (_, _) => SetStatus("Ready. Configure the service and repository, then start processing.");
        FormClosing += (_, _) => SaveUiIntoConfigAndPersist();
    }

    private void BuildUi()
    {
        Text = "Barsa Agent — Issue Worktree Manager";
        Width = 1100;
        Height = 860;
        MinimumSize = new Size(900, 700);
        StartPosition = FormStartPosition.CenterScreen;
        UiTheme.ApplyForm(this);

        var statusStrip = UiTheme.CreateStatusStrip(out _statusLabel, out _statusTimeLabel);
        Controls.Add(statusStrip);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18, 14, 18, 14),
            ColumnCount = 1,
            RowCount = 6,
            BackColor = UiTheme.WindowBackground
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 148F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 150F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58F));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 24F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 105F));

        root.Controls.Add(BuildServiceGroup(), 0, 0);
        root.Controls.Add(BuildRepositoryGroup(), 0, 1);
        root.Controls.Add(BuildActionPanel(), 0, 2);
        root.Controls.Add(BuildResultsGrid(), 0, 3);
        root.Controls.Add(new Label
        {
            Text = "Activity log",
            AutoSize = true,
            Anchor = AnchorStyles.Left | AnchorStyles.Bottom,
            Font = new Font("Segoe UI Semibold", 9F, FontStyle.Bold),
            ForeColor = UiTheme.TextSecondary,
            Margin = new Padding(0, 4, 0, 2)
        }, 0, 4);
        root.Controls.Add(BuildLog(), 0, 5);

        Controls.Add(root);
        statusStrip.BringToFront();
    }

    private GroupBox BuildServiceGroup()
    {
        var group = UiTheme.CreateGroup("Issue service");
        group.Margin = new Padding(0, 0, 0, 8);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 3, Padding = new Padding(4, 2, 4, 2) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 135F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 135F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62F));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 33.34F));

        _txtServiceUrl = CreateTextBox();
        _txtApiKeyHeaderName = CreateTextBox();
        _txtApiKeyValue = CreateTextBox();
        _txtApiKeyValue.UseSystemPasswordChar = true;

        layout.Controls.Add(UiTheme.CreateFieldLabel("Service URL"), 0, 0);
        layout.Controls.Add(_txtServiceUrl, 1, 0);
        layout.SetColumnSpan(_txtServiceUrl, 3);
        layout.Controls.Add(UiTheme.CreateFieldLabel("API key header"), 0, 1);
        layout.Controls.Add(_txtApiKeyHeaderName, 1, 1);
        layout.Controls.Add(UiTheme.CreateFieldLabel("API key value"), 2, 1);
        layout.Controls.Add(_txtApiKeyValue, 3, 1);

        _btnConfigureMapping = new Button { Text = "Configure field mapping", Width = 205, Height = 32, Anchor = AnchorStyles.Left };
        UiTheme.StyleSecondaryButton(_btnConfigureMapping);
        _btnConfigureMapping.Click += (_, _) => OpenMappingForm();
        layout.Controls.Add(_btnConfigureMapping, 0, 2);
        layout.SetColumnSpan(_btnConfigureMapping, 2);

        _lblMappingSummary = new Label
        {
            Text = "Mapping has not been configured.",
            AutoEllipsis = true,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("Segoe UI", 9F)
        };
        layout.Controls.Add(_lblMappingSummary, 2, 2);
        layout.SetColumnSpan(_lblMappingSummary, 2);
        group.Controls.Add(layout);
        return group;
    }

    private GroupBox BuildRepositoryGroup()
    {
        var group = UiTheme.CreateGroup("Repository and worktrees");
        group.Margin = new Padding(0, 0, 0, 8);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 3, Padding = new Padding(4, 2, 4, 2) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 155F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104F));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 33.34F));

        _txtRepoPath = CreateTextBox();
        _txtWorktreeBasePath = CreateTextBox();
        _txtBaseBranch = CreateTextBox();
        _txtBaseBranch.Width = 220;
        _txtBaseBranch.Dock = DockStyle.None;
        _txtBaseBranch.Anchor = AnchorStyles.Left;

        _btnBrowseRepo = CreateBrowseButton();
        _btnBrowseRepo.Click += (_, _) => BrowseFolder(_txtRepoPath, "Repository folder selected.");
        _btnBrowseWorktree = CreateBrowseButton();
        _btnBrowseWorktree.Click += (_, _) => BrowseFolder(_txtWorktreeBasePath, "Worktree base folder selected.");

        layout.Controls.Add(UiTheme.CreateFieldLabel("Repository path"), 0, 0);
        layout.Controls.Add(_txtRepoPath, 1, 0);
        layout.Controls.Add(_btnBrowseRepo, 2, 0);
        layout.Controls.Add(UiTheme.CreateFieldLabel("Worktree base path"), 0, 1);
        layout.Controls.Add(_txtWorktreeBasePath, 1, 1);
        layout.Controls.Add(_btnBrowseWorktree, 2, 1);
        layout.Controls.Add(UiTheme.CreateFieldLabel("Base branch"), 0, 2);
        layout.Controls.Add(_txtBaseBranch, 1, 2);
        group.Controls.Add(layout);
        return group;
    }

    private Control BuildActionPanel()
    {
        var panel = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0, 2, 0, 8) };
        _btnStart = new Button
        {
            Text = "Fetch issues and prepare worktrees",
            Dock = DockStyle.Left,
            Width = 300,
            Height = 42
        };
        UiTheme.StylePrimaryButton(_btnStart);
        _btnStart.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        _btnStart.Click += async (_, _) => await StartAsync();
        panel.Controls.Add(_btnStart);

        var hint = new Label
        {
            Text = "Progress and validation messages appear in the status bar below.",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(16, 0, 0, 0),
            ForeColor = UiTheme.TextSecondary,
            Font = new Font("Segoe UI", 9F)
        };
        panel.Controls.Add(hint);
        hint.BringToFront();
        return panel;
    }

    private DataGridView BuildResultsGrid()
    {
        _dgvResults = new DataGridView
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0),
            ReadOnly = true,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            AllowUserToResizeRows = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect,
            MultiSelect = false,
            RightToLeft = RightToLeft.No,
            BackgroundColor = UiTheme.Surface,
            BorderStyle = BorderStyle.FixedSingle,
            GridColor = Color.FromArgb(229, 231, 235),
            RowHeadersVisible = false,
            EnableHeadersVisualStyles = false,
            ColumnHeadersHeight = 38,
            RowTemplate = { Height = 34 }
        };
        _dgvResults.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle
        {
            BackColor = Color.FromArgb(31, 41, 55),
            ForeColor = Color.White,
            Font = new Font("Segoe UI Semibold", 9F, FontStyle.Bold),
            Alignment = DataGridViewContentAlignment.MiddleLeft,
            Padding = new Padding(4)
        };
        _dgvResults.DefaultCellStyle = new DataGridViewCellStyle
        {
            BackColor = UiTheme.Surface,
            ForeColor = UiTheme.TextPrimary,
            SelectionBackColor = Color.FromArgb(219, 234, 254),
            SelectionForeColor = UiTheme.TextPrimary,
            Font = new Font("Segoe UI", 9F),
            Padding = new Padding(3)
        };
        _dgvResults.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(249, 250, 251);
        _dgvResults.Columns.Add("Id", "ID");
        _dgvResults.Columns.Add("Title", "Title");
        _dgvResults.Columns.Add("Status", "Status");
        _dgvResults.Columns.Add("Branch", "Branch");
        _dgvResults.Columns.Add("Path", "Worktree path");
        _dgvResults.Columns.Add("Message", "Message");
        _dgvResults.Columns[0].FillWeight = 45;
        _dgvResults.Columns[1].FillWeight = 110;
        _dgvResults.Columns[2].FillWeight = 65;
        _dgvResults.Columns[3].FillWeight = 95;
        _dgvResults.Columns[4].FillWeight = 125;
        _dgvResults.Columns[5].FillWeight = 120;
        _dgvResults.SelectionChanged += (_, _) =>
        {
            if (_dgvResults.SelectedRows.Count > 0)
                SetStatus($"Selected issue {_dgvResults.SelectedRows[0].Cells[0].Value}.");
        };
        return _dgvResults;
    }

    private TextBox BuildLog()
    {
        _txtLog = new TextBox
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0),
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            ReadOnly = true,
            BackColor = Color.FromArgb(17, 24, 39),
            ForeColor = Color.FromArgb(209, 213, 219),
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Cascadia Mono", 8.5F)
        };
        return _txtLog;
    }

    private static TextBox CreateTextBox()
    {
        var textBox = new TextBox { Dock = DockStyle.Fill };
        UiTheme.StyleInput(textBox);
        return textBox;
    }

    private static Button CreateBrowseButton()
    {
        var button = new Button { Text = "Browse...", Dock = DockStyle.Fill, Margin = new Padding(6, 4, 0, 4) };
        UiTheme.StyleSecondaryButton(button);
        return button;
    }

    private void LoadConfigIntoUi()
    {
        _txtServiceUrl.Text = _config.ServiceUrl;
        _txtApiKeyHeaderName.Text = string.IsNullOrWhiteSpace(_config.ApiKeyHeaderName) ? "X-Api-Key" : _config.ApiKeyHeaderName;
        _txtApiKeyValue.Text = _config.ApiKeyValue;
        _txtRepoPath.Text = _config.RepoPath;
        _txtWorktreeBasePath.Text = _config.WorktreeBasePath;
        _txtBaseBranch.Text = string.IsNullOrWhiteSpace(_config.BaseBranch) ? "main" : _config.BaseBranch;
        RefreshMappingSummary();
    }

    private void SaveUiIntoConfigAndPersist()
    {
        SyncUiIntoConfig();
        ConfigStore.Save(_config);
    }

    private void SyncUiIntoConfig()
    {
        _config.ServiceUrl = _txtServiceUrl.Text.Trim();
        _config.ApiKeyHeaderName = _txtApiKeyHeaderName.Text.Trim();
        _config.ApiKeyValue = _txtApiKeyValue.Text;
        _config.RepoPath = _txtRepoPath.Text.Trim();
        _config.WorktreeBasePath = _txtWorktreeBasePath.Text.Trim();
        _config.BaseBranch = string.IsNullOrWhiteSpace(_txtBaseBranch.Text.Trim()) ? "main" : _txtBaseBranch.Text.Trim();
    }

    private void RefreshMappingSummary()
    {
        var mapping = _config.Mapping;
        _lblMappingSummary.Text = mapping.IsComplete()
            ? $"Mapping ready · ID: {mapping.IdPath} · Title: {mapping.TitlePath} · Acceptance criteria: {mapping.AcceptanceCriteriaPath}"
            : "Mapping required before processing can start.";
        _lblMappingSummary.ForeColor = mapping.IsComplete() ? UiTheme.Success : UiTheme.Error;
    }

    private void BrowseFolder(TextBox target, string successMessage)
    {
        SetStatus("Waiting for a folder selection...");
        using var dialog = new FolderBrowserDialog { Description = "Select a folder" };
        if (Directory.Exists(target.Text))
            dialog.SelectedPath = target.Text;

        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            target.Text = dialog.SelectedPath;
            SetStatus(successMessage);
        }
        else
        {
            SetStatus("Folder selection canceled.");
        }
    }

    private void OpenMappingForm()
    {
        SyncUiIntoConfig();
        SetStatus("Opening field mapping...");
        using var form = new MappingForm(
            _config.ServiceUrl,
            _config.ApiKeyHeaderName,
            _config.ApiKeyValue,
            _config.RootPath,
            _config.Mapping,
            _issueService);

        if (form.ShowDialog(this) == DialogResult.OK)
        {
            _config.RootPath = form.ResultRootPath;
            _config.Mapping = form.ResultMapping;
            RefreshMappingSummary();
            ConfigStore.Save(_config);
            SetStatus("Field mapping saved.");
        }
        else
        {
            SetStatus("Field mapping was not changed.");
        }
    }

    private async System.Threading.Tasks.Task StartAsync()
    {
        SyncUiIntoConfig();
        if (string.IsNullOrWhiteSpace(_config.ServiceUrl))
        {
            ShowValidationWarning("Enter the issue service URL.");
            return;
        }
        if (!_config.Mapping.IsComplete())
        {
            ShowValidationWarning("Configure at least the ID, Title, and Acceptance Criteria mappings.");
            return;
        }
        if (!_gitService.IsGitRepository(_config.RepoPath))
        {
            ShowValidationWarning("The repository path is invalid. No .git directory was found.");
            return;
        }
        if (string.IsNullOrWhiteSpace(_config.WorktreeBasePath))
        {
            ShowValidationWarning("Select a base folder for worktrees.");
            return;
        }

        ConfigStore.Save(_config);
        _btnStart.Enabled = false;
        _btnStart.Text = "Processing...";
        _dgvResults.Rows.Clear();
        _txtLog.Clear();

        try
        {
            SetStatus("Fetching issues from the service...");
            using var doc = await _issueService.FetchRawAsync(_config.ServiceUrl, _config.ApiKeyHeaderName, _config.ApiKeyValue);
            var issues = _issueService.MapIssues(doc, _config);
            AppendLog($"Fetched and mapped {issues.Count} issue(s).");

            if (issues.Count == 0)
            {
                SetStatus("No issues were found to process.");
                return;
            }

            Directory.CreateDirectory(_config.WorktreeBasePath);
            SetStatus("Running git fetch origin...");
            var (fetchOk, fetchMsg) = await _gitService.FetchOriginAsync(_config.RepoPath);
            AppendLog(fetchMsg);
            if (!fetchOk)
            {
                SetStatus("Git fetch failed. Processing stopped.", UiTheme.Error);
                MessageBox.Show(this, fetchMsg, "Git fetch error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            int success = 0, already = 0, error = 0;
            foreach (var issue in issues)
            {
                SetStatus($"Processing issue {issue.Id}: {issue.Title}");
                var result = await _gitService.PrepareWorktreeAsync(issue, _config);
                AddResultRow(result);
                AppendLog($"[{result.Status}] #{issue.Id} -> {result.BranchName} :: {result.Message}");
                switch (result.Status)
                {
                    case ProcessStatus.Success: success++; break;
                    case ProcessStatus.AlreadyPrepared: already++; break;
                    case ProcessStatus.Error: error++; break;
                }
            }

            SetStatus($"Completed · {success} successful · {already} already prepared · {error} failed",
                error > 0 ? UiTheme.Warning : UiTheme.Success);
        }
        catch (Exception ex)
        {
            SetStatus("Processing failed: " + ex.Message, UiTheme.Error);
            AppendLog("ERROR: " + ex);
            MessageBox.Show(this, ex.Message, "Processing error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _btnStart.Enabled = true;
            _btnStart.Text = "Fetch issues and prepare worktrees";
        }
    }

    private void ShowValidationWarning(string message)
    {
        SetStatus("Validation: " + message, UiTheme.Warning);
        MessageBox.Show(this, message, "Validation", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private void AddResultRow(IssueProcessResult result)
    {
        var rowIndex = _dgvResults.Rows.Add(result.Issue.Id, result.Issue.Title, StatusText(result.Status),
            result.BranchName, result.WorktreePath, result.Message);
        _dgvResults.Rows[rowIndex].DefaultCellStyle.BackColor = result.Status switch
        {
            ProcessStatus.Success => Color.FromArgb(240, 253, 244),
            ProcessStatus.AlreadyPrepared => Color.FromArgb(254, 252, 232),
            ProcessStatus.Error => Color.FromArgb(254, 242, 242),
            _ => UiTheme.Surface
        };
    }

    private static string StatusText(ProcessStatus status) => status switch
    {
        ProcessStatus.Success => "Success",
        ProcessStatus.AlreadyPrepared => "Already prepared",
        ProcessStatus.Error => "Error",
        _ => status.ToString()
    };

    private void SetStatus(string text, Color? color = null)
    {
        _statusLabel.Text = text;
        _statusLabel.ForeColor = color ?? Color.White;
        _statusTimeLabel.Text = DateTime.Now.ToString("HH:mm:ss");
    }

    private void AppendLog(string line)
    {
        _txtLog.AppendText($"[{DateTime.Now:HH:mm:ss}] {line}{Environment.NewLine}");
    }
}
