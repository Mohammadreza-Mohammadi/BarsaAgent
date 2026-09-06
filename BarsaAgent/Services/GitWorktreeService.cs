using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using BarsaAgent.Models;

namespace BarsaAgent.Services;

/// <summary>
/// پیاده‌سازی مرحله اول طبق طراحی: به ازای هر ایشو، یک git worktree مستقل
/// روی برنچ agent/{id}[-{slug}] از روی origin/{baseBranch} می‌سازد.
/// این سرویس هیچ Agentی (Codex/Claude) اجرا نمی‌کند؛ فقط محیط کد را آماده می‌کند.
/// </summary>
public class GitWorktreeService
{
    /// <summary>باید یک‌بار قبل از پردازش کل دسته ایشوها اجرا شود (نه به ازای هر ایشو).</summary>
    public async Task<(bool Success, string Message)> FetchOriginAsync(string repoPath)
    {
        var (success, _, error) = await RunGitAsync(repoPath, "fetch origin");
        return (success, success ? "git fetch origin با موفقیت انجام شد." : error);
    }

    public bool IsGitRepository(string repoPath)
    {
        return Directory.Exists(repoPath) && Directory.Exists(Path.Combine(repoPath, ".git"));
    }

    public async Task<IssueProcessResult> PrepareWorktreeAsync(AgentIssue issue, AppConfig config)
    {
        var result = new IssueProcessResult { Issue = issue };

        var safeId = SanitizeForPath(issue.Id);
        var slugPart = string.IsNullOrWhiteSpace(issue.Slug) ? "" : "-" + Slugify(issue.Slug!);
        var branchName = $"agent/{safeId}{slugPart}";
        var worktreePath = Path.Combine(config.WorktreeBasePath, safeId);

        result.BranchName = branchName;
        result.WorktreePath = worktreePath;

        if (Directory.Exists(worktreePath))
        {
            result.Status = ProcessStatus.AlreadyPrepared;
            result.Message = "پوشه worktree از قبل وجود دارد؛ برای جلوگیری از تغییرات ناخواسته دوباره ساخته نشد.";
            return result;
        }

        var addResult = await RunGitAsync(
            config.RepoPath,
            $"worktree add \"{worktreePath}\" -b \"{branchName}\" origin/{config.BaseBranch}");

        if (!addResult.Success)
        {
            if (addResult.Error.Contains("already exists", StringComparison.OrdinalIgnoreCase))
            {
                // برنچ از قبل وجود دارد؛ بدون ساخت برنچ جدید، همان برنچ را به worktree متصل می‌کنیم.
                var retry = await RunGitAsync(config.RepoPath, $"worktree add \"{worktreePath}\" \"{branchName}\"");

                if (!retry.Success)
                {
                    result.Status = ProcessStatus.Error;
                    result.Message = retry.Error;
                    return result;
                }
            }
            else
            {
                result.Status = ProcessStatus.Error;
                result.Message = addResult.Error;
                return result;
            }
        }

        var branchCheck = await RunGitAsync(worktreePath, "branch --show-current");
        var currentBranch = branchCheck.Output.Trim();

        if (currentBranch != branchName)
        {
            result.Status = ProcessStatus.Error;
            result.Message =
                $"Worktree ساخته شد ولی برنچ فعلی ({currentBranch}) با مقدار مورد انتظار ({branchName}) یکی نیست.";
            return result;
        }

        result.Status = ProcessStatus.Success;
        result.Message = "Worktree با موفقیت آماده شد.";
        return result;
    }

    public async Task<(bool Success, string Output, string Error)> RunGitAsync(string workingDirectory, string arguments)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "git",
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        using var process = new Process { StartInfo = psi };
        process.Start();

        var output = await process.StandardOutput.ReadToEndAsync();
        var error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();

        return (process.ExitCode == 0, output, error);
    }

    public static string SanitizeForPath(string id)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(id.Where(c => !invalid.Contains(c)).ToArray()).Trim();
        return string.IsNullOrWhiteSpace(cleaned) ? "unknown" : cleaned;
    }

    /// <summary>عنوان فارسی/هر متنی را به یک اسلاگ ascii-safe برای نام برنچ گیت تبدیل می‌کند.</summary>
    public static string Slugify(string input)
    {
        var lowered = input.Trim().ToLowerInvariant();
        var sb = new StringBuilder();
        var lastWasDash = false;

        foreach (var c in lowered)
        {
            if (c < 128 && char.IsLetterOrDigit(c))
            {
                sb.Append(c);
                lastWasDash = false;
            }
            else if (!lastWasDash && sb.Length > 0)
            {
                sb.Append('-');
                lastWasDash = true;
            }
        }

        return sb.ToString().Trim('-');
    }
}
