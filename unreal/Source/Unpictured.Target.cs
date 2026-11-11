using UnrealBuildTool;

public class UnpicturedTarget : TargetRules
{
	public UnpicturedTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V6;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_7;
		ExtraModuleNames.Add("Unpictured");
	}
}
