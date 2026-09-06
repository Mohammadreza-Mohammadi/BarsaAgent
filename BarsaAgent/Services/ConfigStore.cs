using System;
using System.IO;
using System.Text.Json;
using BarsaAgent.Models;

namespace BarsaAgent.Services;

/// <summary>
/// ذخیره و بازیابی AppConfig در یک فایل JSON محلی (زیر AppData کاربر ویندوز).
/// توجه: ApiKeyValue به‌صورت متن ساده ذخیره می‌شود (رمزنگاری نشده).
/// </summary>
public static class ConfigStore
{
    private static readonly string ConfigDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BarsaAgent");

    private static readonly string ConfigFile = Path.Combine(ConfigDir, "config.json");

    public static AppConfig Load()
    {
        try
        {
            if (!File.Exists(ConfigFile))
                return new AppConfig();

            var json = File.ReadAllText(ConfigFile);
            return JsonSerializer.Deserialize<AppConfig>(json) ?? new AppConfig();
        }
        catch
        {
            // اگر فایل تنظیمات خراب یا ناسازگار بود، به تنظیمات پیش‌فرض برمی‌گردیم
            // تا برنامه بالا نیاید ولی از باز شدنش جلوگیری نشود.
            return new AppConfig();
        }
    }

    public static void Save(AppConfig config)
    {
        Directory.CreateDirectory(ConfigDir);
        var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(ConfigFile, json);
    }
}
