namespace BarsaAgent.Models;

/// <summary>
/// تمام تنظیماتی که کاربر در فرم اصلی وارد می‌کند و بین اجراهای مختلف برنامه ذخیره می‌شود.
/// نکته امنیتی: این فایل به‌صورت متن ساده (بدون رمزنگاری) در AppData ذخیره می‌شود.
/// </summary>
public class AppConfig
{
    public string ServiceUrl { get; set; } = "";
    public string ApiKeyHeaderName { get; set; } = "X-Api-Key";
    public string ApiKeyValue { get; set; } = "";

    /// <summary>
    /// مسیر dot-notation به آرایه‌ی ایشوها داخل پاسخ JSON.
    /// اگر خالی باشد، فرض می‌شود ریشه‌ی پاسخ خودش همان آرایه است.
    /// مثال: "data.issues"
    /// </summary>
    public string RootPath { get; set; } = "";

    /// <summary>مسیر لوکال ریپازیتوری اصلی که از قبل clone شده (مثلاً D:\Projects\Barsa).</summary>
    public string RepoPath { get; set; } = "";

    /// <summary>پوشه پایه‌ای که worktree هر ایشو داخل آن ساخته می‌شود (مثلاً D:\Projects\agent-work).</summary>
    public string WorktreeBasePath { get; set; } = "";

    /// <summary>نام برنچ مبدا برای ساخت worktreeها (پیش‌فرض main).</summary>
    public string BaseBranch { get; set; } = "main";

    public FieldMapping Mapping { get; set; } = new();
}
