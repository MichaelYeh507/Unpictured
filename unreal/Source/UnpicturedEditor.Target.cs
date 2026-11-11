using UnrealBuildTool;

public class UnpicturedEditorTarget : TargetRules
{
	public UnpicturedEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V6;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_7;
		ExtraModuleNames.Add("Unpictured");
	}
}
